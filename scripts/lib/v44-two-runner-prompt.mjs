const GIT_COMMIT_PATTERN = /^[0-9a-f]{40}$/u;

export function buildAntigravityRunnerPrompt({ workspacePath, sourceCommit }) {
  const workspace = String(workspacePath ?? "").trim();
  const commit = String(sourceCommit ?? "").trim().toLowerCase();
  if (!workspace) throw new Error("WORKSPACE_PATH_REQUIRED");
  if (!GIT_COMMIT_PATTERN.test(commit)) {
    throw new Error("SOURCE_COMMIT_INVALID");
  }

  return `AgentPool 최신 main에서 Antigravity 엔지니어링 증거를 1회 생성해.

작업공간:
${workspace}

규칙:
1. 현재 브랜치가 main인지 읽기 전용으로 확인한다.
2. HEAD가 정확히 아래 커밋인지 확인한다.
${commit}
3. HEAD가 다르면 pull, checkout, 코드 수정하지 말고 현재 branch와 HEAD만 보고하고 중단한다.
4. 기존 untracked 파일을 수정, 삭제, stage하지 않는다.
5. 메인넷 거래, 실제 자산 사용, Faucet 접속, 지갑 생성 또는 충전, 사이트 배포, 코드 수정을 금지한다.
6. 다음 명령을 정확히 1회만 실행한다.

npm.cmd run evidence:v4.4:runner:antigravity

7. 성공하면 생성된 antigravity-*.json 전체 경로, sourceCommit, reportSha256, 시작 및 종료 시각, 통과 또는 실패한 checks를 보고한다.
8. 이 결과는 SHARED_OPERATOR_ENGINEERING_ONLY이며 독립 운영자, 독립 수탁, 검증자 독립성 또는 메인넷 승인 증거가 아님을 명시한다.
9. 데몬이나 반복 Runner를 시작하지 말고 명령 완료 후 종료한다.`;
}
