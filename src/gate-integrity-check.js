import * as acorn from "acorn";
import * as walk from "acorn-walk";

const PROTECTED_GATE_FUNCTIONS = ["passesPlatformSafetyGate", "passesEconomicsGate", "containsForbiddenPaymentField"];
const PROTECTED_CONSTANTS = { MIN_PROFIT_SCORE: 100, MIN_SCRIPT_LENGTH: 80 };

function astParse(code) {
  try {
    return acorn.parse(code, { ecmaVersion: "latest", sourceType: "module" });
  } catch (err) {
    return null;
  }
}

function countCallSites(ast, fnNames) {
  const counts = {};
  for (const name of fnNames) counts[name] = 0;
  walk.simple(ast, {
    CallExpression(node) {
      let calleeName = null;
      if (node.callee.type === "Identifier") {
        calleeName = node.callee.name;
      } else if (node.callee.type === "MemberExpression" && node.callee.property.type === "Identifier") {
        calleeName = node.callee.property.name;
      }
      if (calleeName && fnNames.includes(calleeName)) counts[calleeName]++;
    }
  });
  return counts;
}

function findWeakenedConstants(ast, protectedConstants) {
  const violations = [];
  walk.simple(ast, {
    VariableDeclarator(node) {
      if (node.id.type !== "Identifier") return;
      const name = node.id.name;
      if (!(name in protectedConstants)) return;
      if (!node.init || node.init.type !== "Literal" || typeof node.init.value !== "number") return;
      if (node.init.value < protectedConstants[name]) {
        violations.push({ name, lockedValue: protectedConstants[name], shadowedValue: node.init.value });
      }
    }
  });
  return violations;
}

export function checkGateIntegrity(currentContent, newContent, targetFile) {
  const astCurrent = astParse(currentContent);
  const astNew = astParse(newContent);

  if (!astCurrent || !astNew) {
    console.error("LOUD LOG: AST gate-integrity check could not parse current or new file content as valid JavaScript. Failing closed, deploy aborted.", { targetFile });
    return false;
  }

  const currentCallCounts = countCallSites(astCurrent, PROTECTED_GATE_FUNCTIONS);
  const newCallCounts = countCallSites(astNew, PROTECTED_GATE_FUNCTIONS);

  for (const fnName of PROTECTED_GATE_FUNCTIONS) {
    if (currentCallCounts[fnName] > 0 && newCallCounts[fnName] < currentCallCounts[fnName]) {
      console.error("LOUD LOG: generated code reduces call sites to a locked safety gate function. Deploy aborted.", {
        fnName, before: currentCallCounts[fnName], after: newCallCounts[fnName], targetFile
      });
      return false;
    }
  }

  const weakenedConstants = findWeakenedConstants(astNew, PROTECTED_CONSTANTS);
  if (weakenedConstants.length > 0) {
    console.error("LOUD LOG: generated code locally shadows a protected economics constant with a weaker value. Deploy aborted.", { weakenedConstants, targetFile });
    return false;
  }

  return true;
}