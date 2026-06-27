"use strict";

function isIdentifier(node, name) {
  return node && node.type === "Identifier" && node.name === name;
}

function getPropertyName(node) {
  if (!node) return null;
  if (node.type === "Identifier") return node.name;
  if (node.type === "Literal") return String(node.value);
  return null;
}

function isStyleMember(node) {
  return (
    node &&
    node.type === "MemberExpression" &&
    !node.computed &&
    isIdentifier(node.property, "style")
  );
}

function isStaticValue(node) {
  if (!node) return false;
  if (node.type === "Literal") return true;
  return node.type === "TemplateLiteral" && node.expressions.length === 0;
}

module.exports = {
  meta: {
    type: "suggestion",
    docs: {
      description: "Disallow direct static DOM style assignment.",
    },
    schema: [],
    messages: {
      avoidStyleAssignment:
        "Sets styles directly instead of using CSS classes, `setCssProps`, or `setCssStyles`.",
    },
  },

  create(context) {
    return {
      AssignmentExpression(node) {
        if (!isStaticValue(node.right)) return;
        if (node.left.type !== "MemberExpression") return;
        if (!isStyleMember(node.left.object)) return;

        context.report({
          node,
          messageId: "avoidStyleAssignment",
        });
      },

      CallExpression(node) {
        if (node.callee.type !== "MemberExpression") return;

        const methodName = getPropertyName(node.callee.property);
        if (
          methodName === "setProperty" &&
          isStyleMember(node.callee.object) &&
          isStaticValue(node.arguments[1])
        ) {
          context.report({
            node,
            messageId: "avoidStyleAssignment",
          });
          return;
        }

        if (
          methodName === "setAttribute" &&
          node.arguments[0] &&
          node.arguments[0].type === "Literal" &&
          node.arguments[0].value === "style" &&
          isStaticValue(node.arguments[1])
        ) {
          context.report({
            node,
            messageId: "avoidStyleAssignment",
          });
        }
      },
    };
  },
};
