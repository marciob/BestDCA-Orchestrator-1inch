// orchestrator/index.ts
/**********************************************************************
 * 1️⃣  Orchestrator – posts the master Limit Order, starts the Vault’s
 *     HTLC + DCA timer, streams fills, reveals the secret when done
 *
 *     ▸ Requires NODE ≥18  (crypto.randomBytes is used)
 *     ▸ Env vars:  FRONTEND_URL, BASE_WSS_URL, PRIV_KEY, ONEINCH_API_KEY
 *********************************************************************/
import "dotenv/config";
import {
  WebSocketProvider,
  Wallet,
  Contract,
  Interface,
  id,
  getAddress,
  keccak256,
  toUtf8Bytes,
} from "ethers";
import {
  Api,
  Address,
  Extension,
  LimitOrder,
  MakerTraits,
  randBigInt,
  HttpProviderConnector,
} from "@1inch/limit-order-sdk";
import WebSocket from "ws";
import { randomBytes } from "crypto";

import vaultJson from "../contracts/artifacts/contracts/Vault.sol/Vault.json" assert { type: "json" };
import guardJson from "../contracts/artifacts/contracts/TimeBucketPriceGuard.sol/TimeBucketPriceGuard.json" assert { type: "json" };

/* ─────────────────────────  helpers  ────────────────────────────── */
const ck = (addr: string) => getAddress(addr) as `0x${string}`;

/* ───────── env: where to POST fills ───────── */
const FRONTEND_URL = process.env.FRONTEND_URL!; // e.g. https://best-dca.vercel.app

/* ───────── constants (Base-Sepolia) ───────── */
const CHAIN_ID = 84532;
const VAULT_ADDR = ck("0xe82F3C18a91E25CEe4DeE40C0187fa6dEf89E6E1"); // ← new!
const GUARD_ADDR = ck("0xBA4e75B7b414e5983F92131C7827A9B98e00453e");
const WETH = ck("0x4200000000000000000000000000000000000006");
const WBTC = ck("0xa1b2c3d4e5f678901234567890abcdefabcdef12");
const FEED_ADDR = ck("0xad8CAE210Fe5885AF4fdbF9B709f0a242b6126fA");

/* ───────── provider & signer ───────── */
const provider = new WebSocketProvider(process.env.BASE_WSS_URL!);
const signer = new Wallet(process.env.PRIV_KEY!, provider);

/* ───────── contracts ───────── */
const vault = new Contract(VAULT_ADDR, vaultJson.abi, provider);
const guard = new Contract(GUARD_ADDR, guardJson.abi, provider);

/* ───────── fetch connector for 1inch SDK ───────── */
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
const apiFor = (cid: number) =>
  new Api({
    authKey: process.env.ONEINCH_API_KEY!,
    networkId: cid,
    httpConnector: new FetchConnector(),
  });

/* ───────── order-book stream helper ───────── */
type FillEvt = { type: "FILL"; orderHash: string; makingAmount: bigint };
const streamOrderbook = (
  cid: number,
  hash: string,
  cb: (e: FillEvt) => void
) => {
  const ws = new WebSocket(`wss://api.1inch.dev/orderbook/v1.2/${cid}/ws`, {
    headers: { Authorization: `Bearer ${process.env.ONEINCH_API_KEY}` },
  });
  ws.on("open", () =>
    ws.send(
      JSON.stringify({
        action: "subscribe",
        eventTypes: ["FILL"],
        orderHashes: [hash],
      })
    )
  );
  ws.on("message", (d) => {
    const m = JSON.parse(d.toString());
    if (m.eventType === "FILL")
      cb({
        type: "FILL",
        orderHash: m.orderHash,
        makingAmount: BigInt(m.makingAmount),
      });
  });
  return () => ws.close();
};

/* ───────── cancel helper ───────── */
const cancelOrder = async (hash: string) =>
  fetch("https://api.1inch.dev/orderbook/v1.2/limit-order/cancel", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.ONEINCH_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ orderHash: hash }),
  });

/* ───────── bookkeeping ───────── */
const remaining = new Map<string, bigint>();
const secrets = new Map<string, `0x${string}`>(); // orderHash ➜ secret

/* ───────── listen for Vault.DCAStarted ───────── */
console.log("⏰  waiting for DCAStarted on", VAULT_ADDR);

const iface = new Interface(vaultJson.abi);
const topic = id("DCAStarted(bytes32)");

provider.on({ address: VAULT_ADDR, topics: [topic] }, async (log) => {
  try {
    const orderHash = iface.parseLog(log)!.args[0] as string;
    console.log("⏰  new DCA:", orderHash);

    /* 1️⃣  pull params from vault */
    const params = (await (vault as any).dcaParamsOf(orderHash)) as {
      sliceSize: bigint;
      startTime: bigint;
      deltaTime: bigint;
      totalAmount: bigint;
    };
    const { sliceSize, deltaTime, totalAmount } = params;
    remaining.set(orderHash, totalAmount);

    /* compute duration and HTLC refund time */
    const numberOfSlices = totalAmount / sliceSize;
    const duration = numberOfSlices * deltaTime;
    const refundTime = Number(params.startTime + duration + 86_400n); // +1 day grace

    /* 2️⃣  start HTLC ------------------------------------------------*/
    const secret = ("0x" + randomBytes(32).toString("hex")) as `0x${string}`;
    const hashLock = keccak256(secret as `0x${string}`);
    secrets.set(orderHash, secret);

    const htlcTx = await (vault as any)
      .connect(signer)
      .startHTLC(hashLock, refundTime);
    console.log("🔐 startHTLC tx →", htlcTx.hash);
    await htlcTx.wait();

    /* 3️⃣  build predicate calldata for price-guard */
    const pred = guard.interface.encodeFunctionData("isValidFill", [
      orderHash,
      sliceSize,
    ]);

    /* 4️⃣  maker traits + extension */
    const expiry = BigInt(Math.floor(Date.now() / 1e3)) + 86_400n;
    const traits = MakerTraits.default()
      .setPartialFills(true)
      .allowMultipleFills()
      .withExpiration(expiry)
      .withNonce(randBigInt((1n << 48n) - 1n))
      .withExtension();

    const ext = new Extension({
      makerAssetSuffix: "",
      takerAssetSuffix: "",
      makingAmountData: "",
      takingAmountData: "",
      predicate: pred,
      makerPermit: "",
      preInteraction: "",
      postInteraction: "",
      customData: "",
    });

    /* 5️⃣  assemble + sign order */
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
      ext
    );
    const typed = order.getTypedData(CHAIN_ID);
    const sig = await signer.signTypedData(
      typed.domain,
      { Order: typed.types.Order },
      typed.message
    );

    await apiFor(CHAIN_ID).submitOrder(order, sig);
    console.log("✅  master order posted");

    /* 6️⃣  call startDCA so Vault emits DCAStarted (already fired once) */
    const tx = await (vault as any)
      .connect(signer)
      .startDCA(orderHash, duration, sliceSize, deltaTime);
    console.log("🟢  startDCA tx →", tx.hash);
    await tx.wait();

    /* 7️⃣  live fill stream */
    const unsub = streamOrderbook(CHAIN_ID, orderHash, async (e) => {
      const left = (remaining.get(orderHash) ?? 0n) - e.makingAmount;
      remaining.set(orderHash, left);
      console.log(`⚡ fill: ${e.makingAmount} WETH — left ${left}`);

      /* push to frontend */
      try {
        await fetch(`${FRONTEND_URL}/api/fill`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            id: `${orderHash}-${e.makingAmount}-${Date.now()}`,
            chain: "Base",
            amount: (e.makingAmount / 10n ** 18n).toString(),
            time: new Date().toISOString(),
          }),
        });
      } catch (postErr) {
        console.error("fill → frontend failed:", postErr);
      }

      /* all slices filled → reveal secret + cancel */
      if (left <= 0n) {
        console.log("🎉 DCA complete → revealing secret & cancelling");
        const secretHex = secrets.get(orderHash)!;
        await (vault as any).connect(signer).revealSecret(secretHex);
        cancelOrder(orderHash).catch(console.error);
        remaining.delete(orderHash);
        secrets.delete(orderHash);
        unsub();
      }
    });
  } catch (err) {
    console.warn("❌  handler error:", err);
  }
});

/* ───────── Chainlink watchdog ───────── */
const feedAbi = [
  "function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)",
];
const feed = new Contract(FEED_ADDR, feedAbi, provider);

setInterval(async () => {
  try {
    const { answeredInRound } = await feed.latestRoundData();
    if (answeredInRound === 0n) {
      console.warn("⚠️  stale oracle — cancelling all");
      for (const h of remaining.keys()) {
        cancelOrder(h).catch(console.error);
        remaining.delete(h);
      }
    }
  } catch (e) {
    console.error("oracle check failed:", e);
  }
}, 60_000);
