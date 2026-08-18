// Envelope contract for a navigation-evaluation result: the property names,
// types, and cardinalities a submitted result must carry before any scoring
// runs. Nothing here touches the repository, the fixture suite, or git, so
// these checks are a pure function of the submitted JSON. The CLI still loads
// its evaluation context first, so a malformed result can meet a context error
// before its shape error. `docs-navigation-eval-result.mjs` owns the scoring
// pass, which is where a result is measured against documentation bytes at a
// commit.

export function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function uniqueStrings(values) {
  return (
    Array.isArray(values) &&
    values.every((value) => typeof value === "string" && value.length > 0) &&
    new Set(values).size === values.length
  );
}

function validateObjectContract(value, label, required, allowed, errors) {
  if (!isObject(value)) {
    errors.push(`${label} must be an object`);
    return false;
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) errors.push(`${label} is missing ${key}`);
  }
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      errors.push(`${label} has unexpected property ${key}`);
    }
  }
  return true;
}

function validateLoadedSourceContract(source, label, errors) {
  if (
    !validateObjectContract(
      source,
      label,
      ["path", "bytes", "sha256"],
      ["path", "bytes", "sha256"],
      errors,
    )
  ) {
    return;
  }
  if (typeof source.path !== "string" || source.path.length === 0) {
    errors.push(`${label}.path must be a non-empty string`);
  }
  if (!Number.isSafeInteger(source.bytes) || source.bytes < 1) {
    errors.push(`${label}.bytes must be a positive integer`);
  }
  if (!/^[0-9a-f]{64}$/.test(source.sha256 ?? "")) {
    errors.push(`${label}.sha256 must be a lowercase sha256`);
  }
}

export function validateNavigationResultShape(
  result,
  { minAnswers = 15, maxAnswers = 20 } = {},
) {
  const errors = [];
  if (
    !validateObjectContract(
      result,
      "result",
      ["schema_version", "suite_id", "fixture_digest", "run", "answers"],
      ["schema_version", "suite_id", "fixture_digest", "run", "answers"],
      errors,
    )
  ) {
    return errors;
  }
  if (
    validateObjectContract(
      result.run,
      "result.run",
      [
        "agent",
        "model",
        "effort",
        "executed_at",
        "repository_base_commit",
        "fresh_context",
        "read_only",
        "bootstrap_sources",
      ],
      [
        "agent",
        "model",
        "effort",
        "executed_at",
        "repository_base_commit",
        "fresh_context",
        "read_only",
        "bootstrap_sources",
      ],
      errors,
    )
  ) {
    for (const field of [
      "agent",
      "model",
      "effort",
      "executed_at",
      "repository_base_commit",
    ]) {
      if (typeof result.run[field] !== "string") {
        errors.push(`result.run.${field} must be a string`);
      }
    }
    for (const field of ["fresh_context", "read_only"]) {
      if (typeof result.run[field] !== "boolean") {
        errors.push(`result.run.${field} must be a boolean`);
      }
    }
    if (!Array.isArray(result.run.bootstrap_sources)) {
      errors.push("result.run.bootstrap_sources must be an array");
    } else {
      if (result.run.bootstrap_sources.length < 2) {
        errors.push(
          "result.run.bootstrap_sources must contain at least 2 items",
        );
      }
      result.run.bootstrap_sources.forEach((source, index) =>
        validateLoadedSourceContract(
          source,
          `result.run.bootstrap_sources[${index}]`,
          errors,
        ),
      );
    }
  }
  if (!Array.isArray(result.answers)) {
    errors.push("result.answers must be an array");
    return errors;
  }
  if (
    result.answers.length < minAnswers ||
    result.answers.length > maxAnswers
  ) {
    errors.push(
      minAnswers === maxAnswers
        ? `result.answers must contain exactly ${minAnswers} item`
        : `result.answers must contain ${minAnswers} to ${maxAnswers} items`,
    );
  }
  result.answers.forEach((answer, answerIndex) => {
    const label = `result.answers[${answerIndex}]`;
    if (
      !validateObjectContract(
        answer,
        label,
        [
          "question_id",
          "chosen_documents",
          "answer",
          "evidence",
          "authority_qualifications",
          "loaded_sources",
        ],
        [
          "question_id",
          "chosen_documents",
          "answer",
          "evidence",
          "authority_qualifications",
          "loaded_sources",
        ],
        errors,
      )
    ) {
      return;
    }
    if (typeof answer.question_id !== "string") {
      errors.push(`${label}.question_id must be a string`);
    }
    if (!uniqueStrings(answer.chosen_documents)) {
      errors.push(`${label}.chosen_documents must contain unique strings`);
    } else if (answer.chosen_documents.length === 0) {
      errors.push(`${label}.chosen_documents must not be empty`);
    }
    if (typeof answer.answer !== "string" || answer.answer.length === 0) {
      errors.push(`${label}.answer must be a non-empty string`);
    }
    if (!Array.isArray(answer.evidence)) {
      errors.push(`${label}.evidence must be an array`);
    } else {
      if (answer.evidence.length === 0) {
        errors.push(`${label}.evidence must not be empty`);
      }
      answer.evidence.forEach((evidence, evidenceIndex) => {
        const evidenceLabel = `${label}.evidence[${evidenceIndex}]`;
        if (
          !validateObjectContract(
            evidence,
            evidenceLabel,
            ["path", "line_start", "line_end", "supports"],
            ["path", "line_start", "line_end", "supports"],
            errors,
          )
        ) {
          return;
        }
        if (typeof evidence.path !== "string") {
          errors.push(`${evidenceLabel}.path must be a string`);
        }
        for (const field of ["line_start", "line_end"]) {
          if (!Number.isSafeInteger(evidence[field])) {
            errors.push(`${evidenceLabel}.${field} must be an integer`);
          }
        }
        if (typeof evidence.supports !== "string") {
          errors.push(`${evidenceLabel}.supports must be a string`);
        }
      });
    }
    if (!Array.isArray(answer.authority_qualifications)) {
      errors.push(`${label}.authority_qualifications must be an array`);
    } else {
      if (answer.authority_qualifications.length === 0) {
        errors.push(`${label}.authority_qualifications must not be empty`);
      }
      answer.authority_qualifications.forEach((qualification, index) => {
        const qualificationLabel = `${label}.authority_qualifications[${index}]`;
        if (
          !validateObjectContract(
            qualification,
            qualificationLabel,
            ["path", "authority", "qualification", "verified_against"],
            ["path", "authority", "qualification", "verified_against"],
            errors,
          )
        ) {
          return;
        }
        if (typeof qualification.path !== "string") {
          errors.push(`${qualificationLabel}.path must be a string`);
        }
        if (
          !["canonical", "non-canonical", "unmanaged"].includes(
            qualification.authority,
          )
        ) {
          errors.push(`${qualificationLabel}.authority is invalid`);
        }
        if (typeof qualification.qualification !== "string") {
          errors.push(`${qualificationLabel}.qualification must be a string`);
        }
        if (!uniqueStrings(qualification.verified_against)) {
          errors.push(
            `${qualificationLabel}.verified_against must contain unique strings`,
          );
        }
      });
    }
    if (!Array.isArray(answer.loaded_sources)) {
      errors.push(`${label}.loaded_sources must be an array`);
    } else {
      if (answer.loaded_sources.length === 0) {
        errors.push(`${label}.loaded_sources must not be empty`);
      }
      answer.loaded_sources.forEach((source, index) =>
        validateLoadedSourceContract(
          source,
          `${label}.loaded_sources[${index}]`,
          errors,
        ),
      );
    }
  });
  return errors;
}
