/** Narrow pnpm v9 graph checks; reachability is not TypeScript-program proof. */
import { existsSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";
import {
  terraformTopLevelBlocks,
  nestedBlocks,
  stringAttribute,
  attributeExpression,
} from "../lib/hcl.mjs";

const APPLICATIONS = {
  "alerts/infra/oncall-announcer": "variables.tf",
  "alerts/infra/onchain-event-handler": "variables.tf",
  "governance-watchdog": "infra/cloud_function.tf",
};
const unquote = (text) => text.replace(/^['"]|['"]$/gu, "");

// Read only importer/snapshot edges in pnpm's emitted block format. This is
// not a YAML validator: pnpm's frozen install still owns syntax/schema checks.
export function readGraph(text) {
  if (!/^lockfileVersion: ['"]?9\.0['"]?\s*$/mu.test(text)) {
    throw new Error(
      "dependency semantics supports pnpm lockfileVersion 9.0 only",
    );
  }
  const graph = { importers: new Map(), snapshots: new Map() };
  let section;
  let entry;
  let group;
  let dependency;
  const headers = new Set();
  for (const line of text.split(/\r?\n/u)) {
    if (/^\S/u.test(line)) {
      section = /^(importers|snapshots):$/u.exec(line)?.[1];
      if (section && headers.has(section))
        throw new Error(`duplicate ${section}`);
      if (section) headers.add(section);
      entry = undefined;
      group = undefined;
      continue;
    }
    if (!section || !line.trim()) continue;
    const key = /^ {2}(\S.*):(?: \{\})?$/u.exec(line);
    if (key) {
      entry = {};
      const name = unquote(key[1]);
      if (graph[section].has(name))
        throw new Error(`duplicate graph entry ${name}`);
      graph[section].set(name, entry);
      group = undefined;
      continue;
    }
    const block = /^ {4}(\S+):(?: \{\})?$/u.exec(line);
    if (block) {
      group = [
        "dependencies",
        "devDependencies",
        "optionalDependencies",
      ].includes(block[1])
        ? block[1]
        : undefined;
      if (group) entry[group] = {};
      continue;
    }
    if (!group) continue;
    const edge = /^ {6}([^ ].*?):(?: (.+))?$/u.exec(line);
    if (edge) {
      dependency = unquote(edge[1]);
      if (section === "snapshots") {
        if (!edge[2]) throw new Error(`unsupported edge: ${line}`);
        entry[group][dependency] = unquote(edge[2]);
      }
    } else if (section === "importers") {
      const version = /^ {8}version: (.+)$/u.exec(line);
      if (version) entry[group][dependency] = unquote(version[1]);
    }
  }
  if (!headers.has("importers") || !headers.has("snapshots"))
    throw new Error("missing importer/snapshot graph");
  return graph;
}

function dependencies(entry, development) {
  return {
    ...entry.dependencies,
    ...entry.optionalDependencies,
    ...(development ? entry.devDependencies : {}),
  };
}

export function walkGraph(graph, importer, development, visit) {
  const initial = graph.importers.get(importer);
  if (!initial) throw new Error(`missing importer ${importer}`);
  const queue = Object.entries(dependencies(initial, development)).map(
    ([name, version]) => ({ name, version, parent: importer, importer }),
  );
  const seen = new Set();
  while (queue.length) {
    const edge = queue.pop();
    visit(edge);
    let key;
    let entry;
    let owner = edge.importer;
    if (edge.version.startsWith("link:")) {
      owner = posix.normalize(posix.join(owner, edge.version.slice(5)));
      key = `importer:${owner}`;
      entry = graph.importers.get(owner);
    } else {
      key = /^(?:@[^/]+\/)?[a-z][^@]*@/u.test(edge.version)
        ? edge.version
        : `${edge.name}@${edge.version}`;
      entry = graph.snapshots.get(key);
    }
    if (!entry)
      throw new Error(`missing graph target ${key} from ${edge.parent}`);
    if (seen.has(key)) continue;
    seen.add(key);
    queue.push(
      ...Object.entries(dependencies(entry, development)).map(
        ([name, version]) => ({ name, version, parent: key, importer: owner }),
      ),
    );
  }
}

export function checkGraph(graph, importer, runtimeMajor) {
  const errors = [];
  const entry = graph.importers.get(importer);
  if (!entry) throw new Error(`missing importer ${importer}`);
  const direct = dependencies(entry, true);
  if (!direct["@types/node"]?.match(new RegExp(`^${runtimeMajor}\\.`))) {
    errors.push(
      `${importer}: direct @types/node ${direct["@types/node"]} differs from nodejs${runtimeMajor}`,
    );
  }
  // Runtime dependencies include framework declarations, but exclude isolated
  // build/test tooling. Same-major patches and unused snapshots remain valid.
  walkGraph(graph, importer, false, ({ name, version, parent }) => {
    if (
      name === "@types/node" &&
      !version.match(new RegExp(`^${runtimeMajor}\\.`))
    ) {
      errors.push(
        `${importer}: ${parent} selects @types/node ${version}, expected nodejs${runtimeMajor}`,
      );
    }
  });
  if (direct.tsx) {
    walkGraph(graph, importer, true, ({ name, version, parent }) => {
      if (
        name === "tsx" &&
        parent.startsWith("vite@") &&
        version !== direct.tsx
      ) {
        errors.push(
          `${importer}: ${parent} selects tsx ${version}, direct tsx is ${direct.tsx}`,
        );
      }
    });
  }
  return errors;
}

function runtimeMajor(root, application, file) {
  const source = join(application, file);
  const errors = [];
  const blocks = terraformTopLevelBlocks(
    { [source]: readFileSync(join(root, source), "utf8") },
    errors,
  );
  let runtime;
  if (file === "variables.tf") {
    runtime = stringAttribute(
      blocks.find(
        (block) => block.kind === "variable" && block.name === "runtime",
      ),
      "default",
    );
    const mainFile = `${application}/main.tf`;
    const resources = terraformTopLevelBlocks(
      { [mainFile]: readFileSync(join(root, mainFile), "utf8") },
      errors,
    ).filter((block) => block.type === "google_cloudfunctions2_function");
    if (
      !resources.length ||
      resources.some(
        (block) =>
          nestedBlocks(block, "build_config").length !== 1 ||
          nestedBlocks(block, "build_config").some(
            (build) => attributeExpression(build, "runtime") !== "var.runtime",
          ),
      )
    ) {
      throw new Error(`${application}: unsupported runtime wiring`);
    }
  } else {
    const resources = blocks.filter(
      (block) => block.type === "google_cloudfunctions2_function",
    );
    const runtimes = resources.flatMap((block) =>
      nestedBlocks(block, "build_config").map((build) =>
        stringAttribute(build, "runtime"),
      ),
    );
    if (runtimes.length !== 1)
      throw new Error(`${application}: ambiguous runtime`);
    [runtime] = runtimes;
  }
  const major = /^nodejs(\d+)$/u.exec(runtime ?? "")?.[1];
  if (errors.length || !major)
    throw new Error(
      `${application}: cannot establish runtime: ${errors.join("; ")}`,
    );
  return major;
}

export function validateDependencySemantics(root, members, fail, ok) {
  const applications = Object.keys(APPLICATIONS).filter(
    (application) =>
      members.includes(application) ||
      existsSync(join(root, application, APPLICATIONS[application])),
  );
  if (!applications.length) return;
  const rootGraph = readGraph(
    readFileSync(join(root, "pnpm-lock.yaml"), "utf8"),
  );
  for (const application of applications) {
    const major = runtimeMajor(root, application, APPLICATIONS[application]);
    for (const [context, graph, importer] of [
      ["workspace", rootGraph, application],
      [
        "standalone",
        readGraph(
          readFileSync(join(root, application, "pnpm-lock.yaml"), "utf8"),
        ),
        ".",
      ],
    ]) {
      const errors = checkGraph(graph, importer, major);
      for (const error of errors) fail(`${application} (${context}): ${error}`);
      if (!errors.length)
        ok(
          `${application} (${context}): runtime declaration major and Vite/tsx peer edges aligned`,
        );
    }
  }
}
