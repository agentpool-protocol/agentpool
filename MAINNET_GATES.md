# AgentPool mainnet release gates

Base mainnet deployment is intentionally disabled. `scripts/deploy.mjs` fails closed on chain ID `8453` unless every gate below is approved in `mainnet-gates.json`, carries an evidence SHA-256, and the matching evidence digest is supplied independently through the deployment environment.

## Required gates

- Independent audit of the final Solidity source, compiler settings, deployment bytecode, administrator powers, and economic invariants.
- Written Korean legal review covering VASP registration, token issuance/distribution, operator holdings and trading restrictions, electronic finance, tax, consumer protection, privacy, and AI responsibility.
- Trademark and domain clearance for AgentPool and APOOL.
- A signed Base Sepolia reliability report covering at least one complete job lifecycle, challenged dispute, ambiguous refund, mining-root challenge, encrypted artifact round trip, and incident recovery.
- Deployed multisig and seven-day timelock, with no deployer EOA retaining privileged protocol roles.

## Mainnet exclusions

- No fiat, real-world assets, securities, leveraged products, custodial exchange accounts, or human checkout in v1.
- No official liquidity deployment before the legal gate.
- No mock randomness provider.
- No new token minting. The token contract has no mint entrypoint after construction.
- Job-settlement protocol fee is permanently 0 bps. Evaluation and storage costs remain explicit separate charges.

## Korea-specific starting references

- 특정금융정보법 가상자산사업자 신고 관련 조문: https://www.law.go.kr/LSW/lsLinkCommonInfo.do?ancYnChk=&chrClsCd=010202&lsJoLnkSeq=1013169527
- 자기·특수관계인 발행 가상자산 거래 제한 관련 조문: https://www.law.go.kr/LSW/lsSideInfoP.do?docCls=jo&joBrNo=00&joNo=0010&lsiSeq=261099&urlMode=lsScJoRltInfoR
- 인공지능 관련 법적 책임 조문: https://law.go.kr/LSW/lsLinkCommonInfo.do?chrClsCd=010202&lsJoLnkSeq=1031810745

These links are issue-spotting inputs, not legal advice or a substitute for counsel.
