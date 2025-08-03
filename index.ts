// orchestrator/index.ts
import "dotenv/config";
import { JsonRpcProvider, Wallet, Contract } from "ethers";
import {
  Api,
  Address,
  Extension,
  LimitOrder,
  MakerTraits,
  randBigInt,
  HttpProviderConnector,
} from "@1inch/limit-order-sdk";
import { Interface, id } from "ethers";
import WebSocket from "ws"; // <- node-ws poly-fill

import vaultJson from "../contracts/artifacts/contracts/Vault.sol/Vault.json" assert { type: "json" };
import guardJson from "../contracts/artifacts/contracts/TimeBucketPriceGuard.sol/TimeBucketPriceGuard.json" assert { type: "json" };

/* ─────────── constants (Base-Sepolia) ─────────── */
const RPC_URL = "https://sepolia.base.org";
const CHAIN_ID = 84532;
const VAULT_ADDR = "0xFf30dbaFc3033f591c062d767D5E8A61f5e165B9";
const GUARD_ADDR = "0x0123456789abcdef0123456789abcdef01234567";

const WETH = "0x4200000000000000000000000000000000000006";
const WBTC = "0xYourWBTCtestnetToken"; // 🔁 update
const FEED_ADDR = "0xYourChainlinkFeed"; // 🔁 update (ETH/WBTC)

/* ─────────── provider & signer ─────────── */
const provider = new JsonRpcProvider(RPC_URL);
const signer = new Wallet(process.env.PRIV_KEY!, provider);

/* ─────────── on-chain contracts ─────────── */
const vault = new Contract(VAULT_ADDR, vaultJson.abi, provider);
const guard = new Contract(GUARD_ADDR, guardJson.abi, provider);

/* ─────────── minimal fetch connector ─────────── */
class FetchConnector implements HttpProviderConnector {
  get = <T>(url: string, h: Record<string, string>) =>
    fetch(url, { headers: h }).then((r) => r.json()) as Promise<T>;
  post = <T>(url: string, d: unknown, h: Record<string, string>) =>
    fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...h },
      body: JSON.stringify(d),
    }).then((r) => r.json()) as Promise<T>;
}

/* ─────────── base SDK – only used for submitOrder ─────────── */
const api = new Api({
  authKey: process.env.ONEINCH_API_KEY!,
  networkId: CHAIN_ID,
  httpConnector: new FetchConnector(),
});

/* ─────────── helpers missing from the SDK build ─────────── */
type FillEvt = { type: "FILL"; orderHash: string; makingAmount: bigint };

function streamOrderbook(
  chainId: number,
  orderHash: string,
  cb: (e: FillEvt) => void
) {
  const url = `wss://api.1inch.dev/orderbook/v1.2/${chainId}/ws`;
  const ws = new WebSocket(url, {
    headers: { Authorization: `Bearer ${process.env.ONEINCH_API_KEY}` },
  });

  ws.on("open", () => {
    ws.send(
      JSON.stringify({
        action: "subscribe",
        eventTypes: ["FILL"],
        orderHashes: [orderHash],
      })
    );
  });

  ws.on("message", (data) => {
    const msg = JSON.parse(data.toString());
    if (msg.eventType === "FILL")
      cb({
        type: "FILL",
        orderHash: msg.orderHash,
        makingAmount: BigInt(msg.makingAmount),
      });
  });

  return () => ws.close();
}

async function cancelOrder(orderHash: string) {
  await fetch(`https://api.1inch.dev/orderbook/v1.2/limit-order/cancel`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.ONEINCH_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ orderHash }),
  });
}

/* ─────────── bookkeeping (orderHash → remaining WETH) ─────────── */
const remaining = new Map<string, bigint>();

/* ─────────── listen for DCAStarted events ─────────── */
console.log("⏰  waiting for DCA events on", VAULT_ADDR);

const iface = new Interface(vaultJson.abi);
const topic = id("DCAStarted(bytes32)");

provider.on({ address: VAULT_ADDR, topics: [topic] }, async (log) => {
  try {
    const parsed = iface.parseLog(log)!;
    const orderHash = parsed.args[0] as string;

    console.log("⏰  new DCA", orderHash);

    /* 1. pull params from vault */
    const { sliceSize, totalAmount } = await vault.dcaParams(orderHash);

    remaining.set(orderHash, totalAmount);

    /* 2. predicate via helper contract */
    const predicate = guard.interface.encodeFunctionData("isValidFill", [
      orderHash,
      sliceSize,
    ]);

    const extension = new Extension({
      makerAssetSuffix: "",
      takerAssetSuffix: "",
      makingAmountData: "",
      takingAmountData: "",
      predicate,
      makerPermit: "",
      preInteraction: "",
      postInteraction: "",
      customData: "",
    });

    /* 3. maker traits */
    const expiry = BigInt(Math.floor(Date.now() / 1000)) + 86_400n;
    const traits = MakerTraits.default()
      .setPartialFills(true)
      .allowMultipleFills()
      .withExpiration(expiry)
      .withNonce(randBigInt((1n << 48n) - 1n))
      .withExtension();

    /* 4. build + sign */
    const order = new LimitOrder(
      {
        makerAsset: new Address(WETH),
        takerAsset: new Address(WBTC),
        makingAmount: totalAmount,
        takingAmount: 1n,
        maker: new Address(VAULT_ADDR),
        receiver: new Address(VAULT_ADDR),
      },
      traits,
      extension
    );

    const typed = order.getTypedData(CHAIN_ID);
    const sig = await signer.signTypedData(
      typed.domain,
      { Order: typed.types.Order },
      typed.message
    );

    await api.submitOrder(order, sig);
    console.log("✅  master order posted");

    /* 5. live fill stream */
    const unsub = streamOrderbook(CHAIN_ID, orderHash, (evt) => {
      const left = (remaining.get(orderHash) ?? 0n) - evt.makingAmount;
      remaining.set(orderHash, left);

      console.log(`⚡ slice filled – ${evt.makingAmount} WETH   left: ${left}`);

      if (left <= 0n) {
        console.log("🎉 DCA complete → cancelling order");
        cancelOrder(orderHash).catch(console.error);
        remaining.delete(orderHash);
        unsub();
      }
    });
  } catch (err) {
    console.warn("❌  failed to process event", err);
  }
});

/* ─────────── oracle-health watchdog (optional safety) ─────────── */
const feedAbi = [
  "function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)",
];
const feed = new Contract(FEED_ADDR, feedAbi, provider);

setInterval(async () => {
  try {
    const { answeredInRound } = await feed.latestRoundData();
    if (answeredInRound === 0n) {
      console.warn("⚠️  Chainlink stale – cancelling all active orders");
      for (const hash of remaining.keys()) {
        cancelOrder(hash).catch(console.error);
        remaining.delete(hash);
      }
    }
  } catch (e) {
    console.error("oracle check failed", e);
  }
}, 60_000);
