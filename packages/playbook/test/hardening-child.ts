// Run by hardening.test.ts in a process of its own: when the YAML library overflows the stack it
// can leave the process unable to compile a regular expression, and the process then dies on a
// later call. A test that did this in the test runner's own process would take the runner down.
import { PlaybookError, parsePlaybook } from "../src/index.js";

const depth = Number(process.argv[2]);
const rounds = Number(process.argv[3]);

const valid = `name: Test playbook
contractTypes: [nda]
perspective: We are the receiving party.
rules:
  - id: term
    title: Term
    severity: high
    standard: No more than three years.
`;

let refused = 0;
for (let round = 0; round < rounds; round++) {
  try {
    parsePlaybook("[".repeat(depth) + "]".repeat(depth), "deep.yaml");
  } catch (error) {
    if (error instanceof PlaybookError) refused += 1;
  }
}
// The library has to be usable after the deep documents.
console.log(JSON.stringify({ refused, name: parsePlaybook(valid).name }));
