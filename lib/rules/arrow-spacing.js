/**
 * @fileoverview Rule to define spacing before/after arrow function's arrow.
 * @author Jxck
 * @deprecated in ESLint v8.53.0
 */
"use strict";

//------------------------------------------------------------------------------
// Requirements
//------------------------------------------------------------------------------

const astUtils = require("./utils/ast-utils");

//------------------------------------------------------------------------------
// Rule Definition
//------------------------------------------------------------------------------

/** @type {import('../types').Rule.RuleModule} */
module.exports = {
	meta: {
		deprecated: {
			message: "Formatting rules are being moved out of ESLint core.",
			url: "https://eslint.org/blog/2023/10/deprecating-formatting-rules/",
			deprecatedSince: "8.53.0",
			availableUntil: "10.0.0",
			replacedBy: [
				{
					message:
						"ESLint Stylistic now maintains deprecated stylistic core rules.",
					url: "https://eslint.style/guide/migration",
					plugin: {
						name: "@stylistic/eslint-plugin",
						url: "https://eslint.style",
					},
					rule: {
						name: "arrow-spacing",
						url: "https://eslint.style/rules/arrow-spacing",
					},
				},
			],
		},
		type: "layout",

		docs: {
			description:
				"Enforce consistent spacing before and after the arrow in arrow functions",
			recommended: false,
			url: "https://eslint.org/docs/latest/rules/arrow-spacing",
		},

		fixable: "whitespace",

		schema: [
			{
				type: "object",
				properties: {
					before: {
						type: "boolean",
						default: true,
					},
					after: {
						type: "boolean",
						default: true,
					},
				},
				additionalProperties: false,
			},
		],

		messages: {
			expectedBefore: "Missing space before =>.",
			unexpectedBefore: "Unexpected space before =>.",

			expectedAfter: "Missing space after =>.",
			unexpectedAfter: "Unexpected space after =>.",
		},
	},

	create(context) {
		// merge rules with default
		const rule = Object.assign({}, context.options[0]);

		rule.before = rule.before !== false;
		rule.after = rule.after !== false;

		const sourceCode = context.sourceCode;

		/**
		 * Get tokens of arrow(`=>`) and before/after arrow.
		 * @param {ASTNode} node The arrow function node.
		 * @returns {Object} Tokens of arrow and before/after arrow.
		 */
		function getTokens(node) {
			const arrow = sourceCode.getTokenBefore(
				node.body,
				astUtils.isArrowToken,
			);

			return {
				before: sourceCode.getTokenBefore(arrow),
				arrow,
				after: sourceCode.getTokenAfter(arrow),
			};
		}

		/**
		 * Count spaces before/after arrow(`=>`) token.
		 * @param {Object} tokens Tokens before/after arrow.
		 * @returns {Object} count of space before/after arrow.
		 */
		function countSpaces(tokens) {
			const before = tokens.arrow.range[0] - tokens.before.range[1];
			const after = tokens.after.range[0] - tokens.arrow.range[1];

			return { before, after };
		}

		/**
		 * Determines whether space(s) before after arrow(`=>`) is satisfy rule.
		 * if before/after value is `true`, there should be space(s).
		 * if before/after value is `false`, there should be no space.
		 * @param {ASTNode} node The arrow function node.
		 * @returns {void}
		 */
		function spaces(node) {
			const tokens = getTokens(node);
			const countSpace = countSpaces(tokens);

			if (rule.before) {
				// should be space(s) before arrow
				if (countSpace.before === 0) {
					context.report({
						node: tokens.before,
						messageId: "expectedBefore",
						fix(fixer) {
							return fixer.insertTextBefore(tokens.arrow, " ");
						},
					});
				}
			} else {
				// should be no space before arrow
				if (countSpace.before > 0) {
					context.report({
						node: tokens.before,
						messageId: "unexpectedBefore",
						fix(fixer) {
							return fixer.removeRange([
								tokens.before.range[1],
								tokens.arrow.range[0],
							]);
						},
					});
				}
			}

			if (rule.after) {
				// should be space(s) after arrow
				if (countSpace.after === 0) {
					context.report({
						node: tokens.after,
						messageId: "expectedAfter",
						fix(fixer) {
							return fixer.insertTextAfter(tokens.arrow, " ");
						},
					});
				}
			} else {
				// should be no space after arrow
				if (countSpace.after > 0) {
					context.report({
						node: tokens.after,
						messageId: "unexpectedAfter",
						fix(fixer) {
							return fixer.removeRange([
								tokens.arrow.range[1],
								tokens.after.range[0],
							]);
						},
					});
				}
			}
		}

		return {
			ArrowFunctionExpression: spaces,
		};
	},
};
