// Judge request policy is grading-only; auth, confinement and capture stay shared.
import { claudeArgv } from "./review-eval-run-execution.mjs";

function judgeArguments(request) {
  return claudeArgv(request);
}

export function invokeJudge(provider, request) {
  return provider.invoke(request, judgeArguments);
}
