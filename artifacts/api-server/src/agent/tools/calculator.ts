import type { ToolDefinition, ToolResult } from "../types";

const MAX_LENGTH = 200;

type Token = { kind: "number"; value: number } | { kind: "operator"; value: string } | { kind: "paren"; value: "(" | ")" };

function tokenize(expression: string): Token[] {
  if (expression.length > MAX_LENGTH) throw new Error("Expression is too long.");
  const tokens: Token[] = [];
  let i = 0;
  let expectValue = true;
  while (i < expression.length) {
    const char = expression[i];
    if (/\s/.test(char)) { i += 1; continue; }
    if (/[0-9.]/.test(char)) {
      const match = expression.slice(i).match(/^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?/i);
      if (!match) throw new Error("Invalid number.");
      const value = Number(match[0]);
      if (!Number.isFinite(value)) throw new Error("Number is out of range.");
      tokens.push({ kind: "number", value });
      i += match[0].length;
      expectValue = false;
      continue;
    }
    if (char === "(" || char === ")") {
      tokens.push({ kind: "paren", value: char });
      i += 1;
      expectValue = char === "(";
      continue;
    }
    const op = expression.slice(i, i + 2) === "**" ? "**" : char;
    if (["+", "-", "*", "/", "%", "**"].includes(op)) {
      if ((op === "+" || op === "-") && expectValue) {
        tokens.push({ kind: "operator", value: op === "+" ? "u+" : "u-" });
      } else {
        if (expectValue) throw new Error("Unexpected operator.");
        tokens.push({ kind: "operator", value: op });
      }
      i += op.length;
      expectValue = true;
      continue;
    }
    throw new Error(`Unsupported character: ${char}`);
  }
  if (!tokens.length || expectValue) throw new Error("Incomplete expression.");
  return tokens;
}

const precedence: Record<string, number> = { "u+": 5, "u-": 5, "**": 4, "*": 3, "/": 3, "%": 3, "+": 2, "-": 2 };
const rightAssociative = new Set(["u+", "u-", "**"]);

function toRpn(tokens: Token[]): Token[] {
  const output: Token[] = [];
  const operators: Token[] = [];
  for (const token of tokens) {
    if (token.kind === "number") { output.push(token); continue; }
    if (token.kind === "paren") {
      if (token.value === "(") operators.push(token);
      else {
        while (operators.length && operators[operators.length - 1].kind !== "paren") output.push(operators.pop()!);
        if (!operators.length) throw new Error("Mismatched parentheses.");
        operators.pop();
      }
      continue;
    }
    while (operators.length && operators[operators.length - 1].kind === "operator") {
      const top = operators[operators.length - 1].value;
      const shouldPop = rightAssociative.has(token.value) ? precedence[token.value] < precedence[top] : precedence[token.value] <= precedence[top];
      if (!shouldPop) break;
      output.push(operators.pop()!);
    }
    operators.push(token);
  }
  while (operators.length) {
    const token = operators.pop()!;
    if (token.kind === "paren") throw new Error("Mismatched parentheses.");
    output.push(token);
  }
  return output;
}

function evaluateRpn(tokens: Token[]): number {
  const stack: number[] = [];
  for (const token of tokens) {
    if (token.kind === "number") { stack.push(token.value); continue; }
    const arity = token.value === "u+" || token.value === "u-" ? 1 : 2;
    if (stack.length < arity) throw new Error("Invalid expression.");
    if (arity === 1) {
      const value = stack.pop()!;
      stack.push(token.value === "u-" ? -value : value);
      continue;
    }
    const right = stack.pop()!;
    const left = stack.pop()!;
    let value: number;
    switch (token.value) {
      case "+": value = left + right; break;
      case "-": value = left - right; break;
      case "*": value = left * right; break;
      case "/": if (right === 0) throw new Error("Division by zero."); value = left / right; break;
      case "%": if (right === 0) throw new Error("Division by zero."); value = left % right; break;
      case "**": value = left ** right; break;
      default: throw new Error("Unsupported operator.");
    }
    if (!Number.isFinite(value)) throw new Error("Result is out of range.");
    stack.push(value);
  }
  if (stack.length !== 1) throw new Error("Invalid expression.");
  return stack[0];
}

export function calculate(expression: string): number {
  return evaluateRpn(toRpn(tokenize(expression)));
}

export const calculatorTool: ToolDefinition = {
  name: "calculator",
  description: "Safely evaluate arithmetic expressions using numbers, parentheses, +, -, *, /, %, and **.",
  inputSchema: { expression: { type: "string", description: "Arithmetic expression, for example (18 * 4) / 3" } },
  async execute(arguments_): Promise<ToolResult> {
    const expression = typeof arguments_.expression === "string" ? arguments_.expression.trim() : "";
    if (!expression) return { ok: false, content: "Calculator requires an expression." };
    try {
      const value = calculate(expression);
      return { ok: true, content: `${expression} = ${value}` };
    } catch (error) {
      return { ok: false, content: error instanceof Error ? error.message : "Could not calculate the expression." };
    }
  },
};
