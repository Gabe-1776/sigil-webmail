import { readFileSync } from "node:fs";
import { Api, JsonRpc, JsSignatureProvider } from "@proton/js";
const AUTH = "https://testnet-auth.mailsigil.pro";
export async function login(actor) {
  const w = JSON.parse(readFileSync(process.env.HOME + "/.xpr-testnet/wallets.json", "utf-8"));
  const n = await fetch(AUTH + "/api/auth/nonce", { method: "POST" }).then(r => r.json());
  const api = new Api({ rpc: new JsonRpc(["https://tn1.protonnz.com"], { fetch }),
    signatureProvider: new JsSignatureProvider([w.accounts[actor].private_key]) });
  const s = await api.transact({ actions: [{ account: "sigillogin", name: "login",
    authorization: [{ actor, permission: "active" }],
    data: { account: actor, nonce: n.message.match(/Nonce: (\S+)/)[1] } }] },
    { blocksBehind: 3, expireSeconds: 120, broadcast: false, sign: true });
  return fetch(AUTH + "/api/auth/verify", { method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ challengeId: n.challengeId, actor, permission: "active",
      signatures: s.signatures, serializedTransaction: Buffer.from(s.serializedTransaction).toString("hex") })
  }).then(r => r.json());
}
