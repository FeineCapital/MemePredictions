// Read-only snapshot of the devnet program: config, resolver, every market.
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import idl from "../target/idl/mememarkets.json";
import { Mememarkets } from "../target/types/mememarkets";
const conn = new Connection(process.env.RPC_URL ?? `https://devnet.helius-rpc.com/?api-key=${require("fs").readFileSync(require("os").homedir() + "/.config/solana/mememarkets-mainnet/helius-key", "utf8").trim()}`, "confirmed");
const program = new Program<Mememarkets>(idl as Mememarkets, new anchor.AnchorProvider(conn, new anchor.Wallet(Keypair.generate()), {}));
const [config] = PublicKey.findProgramAddressSync([Buffer.from("config")], program.programId);
const [resolver] = PublicKey.findProgramAddressSync([Buffer.from("resolver")], program.programId);
(async () => {
  const c = await program.account.config.fetch(config);
  const r = await program.account.resolverConfig.fetchNullable(resolver);
  console.log(`admin ${c.admin.toBase58()} | resolver ${r?.resolver.toBase58() ?? "none"} | paused ${c.paused} | fee ${c.feeBps}bps | min ${c.minBet.toNumber() / 1e6} max ${c.maxBet.toNumber() / 1e6} USDC | payout delay ${c.disputeSecs.toNumber()}s | open creation ${c.openCreation} creator share ${c.creatorFeeShareBps / 100}% | markets ${c.marketCount.toString()}`);
  const now = Math.floor(Date.now() / 1000);
  for (const { account: m } of (await program.account.market.all()).sort((a, b) => a.account.id.toNumber() - b.account.id.toNumber())) {
    const left = m.endTs.toNumber() - now;
    console.log(`#${m.id} ${Object.keys(m.status)[0]} outcomes ${m.outcomeCount} verified ${m.verified} pools ${m.reserves.slice(0, m.outcomeCount).map((r: any) => "$" + r.toNumber() / 1e6).join(" / ")} result ${m.result} ${left > 0 ? `closes in ${Math.round(left / 60)}m` : "past deadline"} creator ${m.creator.toBase58().slice(0, 6)}`);
  }
})();
