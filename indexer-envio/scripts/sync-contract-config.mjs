#!/usr/bin/env node

import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = resolve(__dirname, "..");
const workspaceRoot = resolve(projectRoot, "..", "..");
const mentoCoreRoot = resolve(workspaceRoot, "..", "mento-core");

const addressBookPath = join(
  workspaceRoot,
  "tools",
  "address-book",
  "addresses.json",
);
const contractsOutputPath = join(
  projectRoot,
  "config",
  "contracts.celo.v3.json",
);
const configOutputPath = join(projectRoot, "config.yaml");
const abisDir = join(projectRoot, "abis");

const CONTRACT_SPECS = [
  {
    label: "FPMMFactory",
    contractName: "FPMMFactory",
    artifactPath: join(
      mentoCoreRoot,
      "out",
      "FPMMFactory.sol",
      "FPMMFactory.json",
    ),
    abiFilePath: "abis/FPMMFactory.json",
    events: ["FPMMDeployed"],
  },
  {
    label: "FPMM KESm/USDm",
    contractName: "FPMM",
    artifactPath: join(mentoCoreRoot, "out", "FPMM.sol", "FPMM.json"),
    abiFilePath: "abis/FPMM.json",
    events: ["Swap", "Mint", "Burn", "UpdateReserves", "Rebalanced"],
  },
  {
    label: "VirtualPoolFactory",
    contractName: "VirtualPoolFactory",
    artifactPath: join(
      mentoCoreRoot,
      "out",
      "VirtualPoolFactory.sol",
      "VirtualPoolFactory.json",
    ),
    abiFilePath: "abis/VirtualPoolFactory.json",
    events: ["VirtualPoolDeployed", "PoolDeprecated"],
  },
];

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

const main = () => {
  if (!existsSync(addressBookPath)) {
    throw new Error(`Address book not found: ${addressBookPath}`);
  }

  const addressBook = readJson(addressBookPath);
  const celoNetwork = addressBook.networks?.find(
    (network) => network.id === "celo",
  );

  if (!celoNetwork) {
    throw new Error(
      "Unable to find celo network in tools/address-book/addresses.json",
    );
  }
  if (!celoNetwork.rpcUrl) {
    throw new Error(
      "Missing rpcUrl for celo network in tools/address-book/addresses.json",
    );
  }
  const rpcUrl = celoNetwork.rpcUrl;

  const addressByLabel = new Map(
    (celoNetwork.addresses ?? []).map((entry) => [entry.label, entry.address]),
  );

  const contracts = CONTRACT_SPECS.map((spec) => {
    const address = addressByLabel.get(spec.label);

    if (!address) {
      throw new Error(
        `Missing address for label "${spec.label}" in address book`,
      );
    }

    if (!existsSync(spec.artifactPath)) {
      throw new Error(`ABI artifact not found: ${spec.artifactPath}`);
    }

    return {
      label: spec.label,
      contractName: spec.contractName,
      address,
      artifactPath: spec.artifactPath,
      abiFilePath: spec.abiFilePath,
      events: spec.events,
    };
  });

  mkdirSync(dirname(contractsOutputPath), { recursive: true });
  mkdirSync(abisDir, { recursive: true });

  for (const contract of contracts) {
    const destination = join(projectRoot, contract.abiFilePath);
    cpSync(contract.artifactPath, destination);
  }

  const contractManifest = {
    generatedAt: new Date().toISOString(),
    chain: {
      id: 42220,
      name: "celo-devnet",
      rpcUrl,
      source: "tools/address-book/addresses.json",
    },
    contracts: contracts.map(
      ({ label, contractName, address, abiFilePath, events }) => ({
        label,
        contractName,
        address,
        abiFilePath,
        events,
      }),
    ),
  };

  writeFileSync(
    contractsOutputPath,
    `${JSON.stringify(contractManifest, null, 2)}\n`,
  );

  const contractsYaml = contracts
    .map((contract) => {
      const eventsYaml = contract.events
        .map((event) => `          - event: ${event}`)
        .join("\n");
      return [
        `      - name: ${contract.contractName}`,
        `        abi_file_path: ${contract.abiFilePath}`,
        "        address:",
        `          - ${contract.address}`,
        "        handler: src/EventHandlers.ts",
        "        events:",
        eventsYaml,
      ].join("\n");
    })
    .join("\n");

  const configYaml = `# yaml-language-server: $schema=./node_modules/envio/evm.schema.json
name: celo
description: Celo devnet v3 FPMM-focused HyperIndex indexer
networks:
  - id: 42220
    rpc_config:
      url: \${ENVIO_RPC_URL:-${rpcUrl}}
    start_block: \${ENVIO_START_BLOCK:-0}
    contracts:
${contractsYaml}
unordered_multichain_mode: true
preload_handlers: true
`;

  writeFileSync(configOutputPath, configYaml);

  console.log("Wrote contract manifest:", contractsOutputPath);
  console.log("Updated config:", configOutputPath);
  console.log("Synced ABI artifacts into:", abisDir);
};

main();
