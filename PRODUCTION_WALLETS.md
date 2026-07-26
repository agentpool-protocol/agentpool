# AgentPool production wallets

Mainnet is still blocked. This document prepares public addresses only; it does
not authorize or perform a Base mainnet deployment.

## Three-device signer layout

Create one completely independent signer on each device:

| Device | Install | Signer |
| --- | --- | --- |
| Desktop PC | Rabby browser extension from `https://rabby.io` | Owner 1 |
| Laptop | MetaMask browser extension from `https://metamask.io/download` | Owner 2 |
| Phone | MetaMask Mobile from `https://metamask.io/download` | Owner 3 |

Each signer must have its own newly generated seed or owner key. Never import
the desktop seed into the laptop or phone. Browser sync must not copy wallet
secrets between devices.

Safe Mobile is optional account-management software after the Safe contracts
exist. Its `Add account` flow adds an existing Safe smart account; it is not
used as the required phone key-creation step in this plan.

Use the three owners for a 2-of-3 Safe policy. Any two devices can approve a
transaction, one lost device can be replaced, and one compromised device cannot
move funds alone.

## Safe accounts

The three signer wallets are keys. The following eight addresses are separate
Safe smart-account contracts and do not each have another seed phrase:

| Safe | Purpose | Required policy |
| --- | --- | --- |
| Founder | Founder vesting beneficiary; not for daily spending | 2 of 3 |
| Governance | Timelock and protocol administration | 2 of 3 |
| Ecosystem | Grants and integrations | 2 of 3 |
| Operations | Hosting, indexing, support, and routine expenses | 2 of 3 |
| Validator | Validator incentives | 2 of 3 |
| Author | Verifier and asset-author incentives | 2 of 3 |
| Liquidity | Future liquidity only after legal approval | 2 of 3 |
| Security | Incident response, audits, and slashing receipts | 2 of 3 |

All eight Safes use the same three owners but have distinct contract addresses,
balances, and accounting. A future governance action may replace one owner with
a hardware wallet or independent signer without changing the treasury roles.

## Creation and backup rules

1. On the desktop, create a new Rabby wallet and write its recovery words on
   paper. Do not take a photo or save them in a file.
2. On the laptop, create a separate new MetaMask wallet and write its different
   recovery words on a second paper backup.
3. On the phone, create a completely new MetaMask Mobile wallet. Do not import
   either computer's recovery phrase. Enable the phone PIN/biometric lock and
   record the new recovery phrase on a third paper backup.
4. Keep the three backups in separate physical locations. Do not keep all
   backups beside the desktop.
5. Record only the three public `0x...` addresses in
   `.env.wallets.local`.

Never reuse a disposable Base Sepolia key. Never send a seed phrase or private
key through chat, email, cloud notes, screenshots, or this repository.

## Address planning

Copy `.env.wallets.example` to `.env.wallets.local`, set
`AGENTPOOL_OWNER_PROFILE=production`, and add the three public addresses. Then
run:

```powershell
npm run wallets:plan-mainnet
```

The command predicts eight deterministic Base mainnet Safe addresses without
deploying them or requesting private keys. The Founder Safe becomes
`FOUNDER_BENEFICIARY`. The output is written to
`outputs/production-safe-plan.json`.

After the independent audit, legal review, trademark check, testnet reliability
period, validator economics review, and signer rehearsal are complete, deploy
the eight Safes using the exact owner set, threshold, version, and salts in that
plan. AgentPool's mainnet preflight checks every Safe on-chain and requires the
same three owners before it will deploy APOOL.

## What not to do yet

- Do not buy or bridge mainnet ETH for AgentPool deployment.
- Do not deploy APOOL on Base mainnet.
- Do not add liquidity or promise a token price.
- Do not import the testnet private keys into these wallets.
- Do not put all three recovery backups on either computer.
