import fs from "node:fs";
import path from "node:path";
import solc from "solc";

const root = process.cwd();
const contractsDir = path.join(root, "contracts");
const outputDir = path.join(root, "artifacts");

function canonicalSource(file) {
  return fs.readFileSync(file, "utf8").replace(/\r\n?/gu, "\n");
}

function walk(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(absolute) : [absolute];
  });
}

const sources = Object.fromEntries(
  walk(contractsDir)
    .filter((file) => file.endsWith(".sol"))
    .map((file) => [
      path.relative(root, file).replaceAll("\\", "/"),
      { content: canonicalSource(file) },
    ]),
);

const input = {
  language: "Solidity",
  sources,
  settings: {
    optimizer: { enabled: true, runs: 500 },
    viaIR: true,
    evmVersion: "cancun",
    outputSelection: {
      "*": {
        "*": ["abi", "evm.bytecode.object", "evm.deployedBytecode.object", "metadata"],
      },
    },
  },
};

function resolveImport(importPath) {
  const candidates = [
    path.join(root, importPath),
    path.join(root, "node_modules", importPath),
  ];
  const match = candidates.find((candidate) => fs.existsSync(candidate));
  return match
    ? { contents: canonicalSource(match) }
    : { error: `Import not found: ${importPath}` };
}

const output = JSON.parse(solc.compile(JSON.stringify(input), { import: resolveImport }));
const errors = (output.errors ?? []).filter((entry) => entry.severity === "error");
for (const entry of output.errors ?? []) {
  const stream = entry.severity === "error" ? process.stderr : process.stdout;
  stream.write(`${entry.formattedMessage}\n`);
}
if (errors.length > 0) process.exit(1);

fs.mkdirSync(outputDir, { recursive: true });
let count = 0;
for (const [sourceName, contracts] of Object.entries(output.contracts)) {
  for (const [contractName, artifact] of Object.entries(contracts)) {
    if (!artifact.evm.bytecode.object) continue;
    const target = path.join(outputDir, `${contractName}.json`);
    fs.writeFileSync(target, JSON.stringify({
      contractName,
      sourceName,
      abi: artifact.abi,
      bytecode: `0x${artifact.evm.bytecode.object}`,
      deployedBytecode: `0x${artifact.evm.deployedBytecode.object}`,
    }, null, 2));
    count += 1;
  }
}
console.log(`Compiled ${count} AgentPool contracts with solc ${solc.version()}.`);
