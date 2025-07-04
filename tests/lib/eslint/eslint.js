/**
 * @fileoverview Tests for the ESLint class.
 * @author Kai Cataldo
 * @author Toru Nagashima
 */

"use strict";

/**
 * @import { ESLintOptions } from '../../../lib/eslint/eslint.js';
 */

//------------------------------------------------------------------------------
// Requirements
//------------------------------------------------------------------------------

const assert = require("node:assert");
const util = require("node:util");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const timers = require("node:timers/promises");
const escapeStringRegExp = require("escape-string-regexp");
const fCache = require("file-entry-cache");
const sinon = require("sinon");
const proxyquire = require("proxyquire").noCallThru().noPreserveCache();
const shell = require("shelljs");
const hash = require("../../../lib/cli-engine/hash");
const { unIndent, createCustomTeardown } = require("../../_utils");
const { shouldUseFlatConfig } = require("../../../lib/eslint/eslint");
const { defaultConfig } = require("../../../lib/config/default-config");
const coreRules = require("../../../lib/rules");
const espree = require("espree");
const { WarningService } = require("../../../lib/services/warning-service");

//------------------------------------------------------------------------------
// Constants
//------------------------------------------------------------------------------

const JITI_VERSIONS = ["jiti", "jiti-v2.0", "jiti-v2.1"];

//------------------------------------------------------------------------------
// Helpers
//------------------------------------------------------------------------------

/**
 * Creates a directory if it doesn't already exist.
 * @param {string} dirPath The path to the directory that should exist.
 * @returns {void}
 */
function ensureDirectoryExists(dirPath) {
	try {
		fs.statSync(dirPath);
	} catch {
		fs.mkdirSync(dirPath);
	}
}

/**
 * Does nothing for a given time.
 * @param {number} time Time in ms.
 * @returns {Promise<void>}
 */
async function sleep(time) {
	await util.promisify(setTimeout)(time);
}

/**
 * An object mapping file extensions to their corresponding
 * ESLint configuration file names.
 * @satisfies {Record<string, string>}
 */
const eslintConfigFiles = {
	ts: "eslint.config.ts",
	mts: "eslint.config.mts",
	cts: "eslint.config.cts",
	js: "eslint.config.js",
	mjs: "eslint.config.mjs",
	cjs: "eslint.config.cjs",
};

//------------------------------------------------------------------------------
// Tests
//------------------------------------------------------------------------------

describe("ESLint", () => {
	const { ConfigLoader } = require("../../../lib/config/config-loader.js");

	const examplePluginName = "eslint-plugin-example";
	const examplePluginNameWithNamespace = "@eslint/eslint-plugin-example";
	const examplePlugin = {
		rules: {
			"example-rule": require("../../fixtures/rules/custom-rule"),
			"make-syntax-error": require("../../fixtures/rules/make-syntax-error-rule"),
		},
	};
	const examplePreprocessorName = "eslint-plugin-processor";
	const patternProcessor = require("../../fixtures/processors/pattern-processor");
	const exampleMarkdownPlugin = {
		processors: {
			markdown: patternProcessor.defineProcessor(
				/```(\w+)\n(.+?)\n```(?:\n|$)/gsu,
			),
		},
	};
	const originalDir = process.cwd();
	const fixtureDir = path.resolve(
		fs.realpathSync(os.tmpdir()),
		"eslint/fixtures",
	);

	/** @typedef {typeof import("../../../lib/eslint/eslint").ESLint} ESLint */

	/** @type {ESLint} */
	let ESLint;

	/**
	 * Returns the path inside of the fixture directory.
	 * @param {...string} args file path segments.
	 * @returns {string} The path inside the fixture directory.
	 * @private
	 */
	function getFixturePath(...args) {
		const filepath = path.join(fixtureDir, ...args);

		try {
			return fs.realpathSync(filepath);
		} catch {
			return filepath;
		}
	}

	/**
	 * Create the ESLint object by mocking some of the plugins
	 * @param {ESLintOptions} options options for ESLint
	 * @returns {InstanceType<ESLint>} engine object
	 * @private
	 */
	function eslintWithPlugins(options) {
		return new ESLint({
			...options,
			plugins: {
				[examplePluginName]: examplePlugin,
				[examplePluginNameWithNamespace]: examplePlugin,
				[examplePreprocessorName]: require("../../fixtures/processors/custom-processor"),
			},
		});
	}

	// copy into clean area so as not to get "infected" by this project's .eslintrc files
	before(function () {
		/*
		 * GitHub Actions Windows and macOS runners occasionally exhibit
		 * extremely slow filesystem operations, during which copying fixtures
		 * exceeds the default test timeout, so raise it just for this hook.
		 * Mocha uses `this` to set timeouts on an individual hook level.
		 */
		this.timeout(60 * 1000); // eslint-disable-line no-invalid-this -- Mocha API
		shell.mkdir("-p", fixtureDir);
		shell.cp("-r", "./tests/fixtures/.", fixtureDir);
	});

	after(() => {
		shell.rm("-r", fixtureDir);
	});

	beforeEach(() => {
		({ ESLint } = require("../../../lib/eslint/eslint"));

		// Silence ".eslintignore" warnings for tests
		sinon.stub(WarningService.prototype, "emitESLintIgnoreWarning");
	});

	afterEach(() => {
		sinon.restore();
	});

	[[], ["v10_config_lookup_from_file"]].forEach(flags => {
		/**
		 * Configuration flags for TypeScript integration in Node.js,
		 * including existing {@linkcode flags} and
		 * `"unstable_native_nodejs_ts_config"`.
		 * @satisfies {ESLintOptions['flags']}
		 */
		const nativeTSConfigFileFlags = [
			...flags,
			"unstable_native_nodejs_ts_config",
		];

		describe("ESLint constructor function", () => {
			it("should have a static property indicating the configType being used", () => {
				assert.strictEqual(ESLint.configType, "flat");
			});

			it("should have the defaultConfig static property", () => {
				assert.deepStrictEqual(ESLint.defaultConfig, defaultConfig);
			});

			it("the default value of 'options.cwd' should be the current working directory.", async () => {
				process.chdir(__dirname);
				try {
					const engine = new ESLint({ flags });
					const results = await engine.lintFiles("eslint.js");

					assert.strictEqual(
						path.dirname(results[0].filePath),
						__dirname,
					);
				} finally {
					process.chdir(originalDir);
				}
			});

			it("should normalize 'options.cwd'.", async () => {
				const cwd = getFixturePath("example-app3");
				const engine = new ESLint({
					flags,
					cwd: `${cwd}${path.sep}foo${path.sep}..`, // `<cwd>/foo/..` should be normalized to `<cwd>`
					overrideConfigFile: true,
					overrideConfig: {
						plugins: {
							test: require(
								path.join(
									cwd,
									"node_modules",
									"eslint-plugin-test",
								),
							),
						},
						rules: {
							"test/report-cwd": "error",
						},
					},
				});
				const results = await engine.lintText("");

				assert.strictEqual(
					results[0].messages[0].ruleId,
					"test/report-cwd",
				);
				assert.strictEqual(results[0].messages[0].message, cwd);

				const formatter = await engine.loadFormatter("cwd");

				assert.strictEqual(formatter.format(results), cwd);
			});

			// https://github.com/eslint/eslint/issues/2380
			it("should not modify baseConfig in the constructor", () => {
				const customBaseConfig = { root: true };

				new ESLint({ baseConfig: customBaseConfig, flags }); // eslint-disable-line no-new -- Check for argument side effects

				assert.deepStrictEqual(customBaseConfig, { root: true });
			});

			it("should throw readable messages if removed options are present", () => {
				assert.throws(
					() =>
						new ESLint({
							flags,
							cacheFile: "",
							configFile: "",
							envs: [],
							globals: [],
							ignorePath: ".gitignore",
							ignorePattern: [],
							parser: "",
							parserOptions: {},
							rules: {},
							plugins: [],
							reportUnusedDisableDirectives: "error",
						}),
					new RegExp(
						escapeStringRegExp(
							[
								"Invalid Options:",
								"- Unknown options: cacheFile, configFile, envs, globals, ignorePath, ignorePattern, parser, parserOptions, rules, reportUnusedDisableDirectives",
							].join("\n"),
						),
						"u",
					),
				);
			});

			it("should throw readable messages if wrong type values are given to options", () => {
				assert.throws(
					() =>
						new ESLint({
							flags,
							allowInlineConfig: "",
							baseConfig: "",
							cache: "",
							cacheLocation: "",
							cwd: "foo",
							errorOnUnmatchedPattern: "",
							fix: "",
							fixTypes: ["xyz"],
							globInputPaths: "",
							ignore: "",
							ignorePatterns: "",
							overrideConfig: "",
							overrideConfigFile: "",
							plugins: "",
							warnIgnored: "",
							ruleFilter: "",
						}),
					new RegExp(
						escapeStringRegExp(
							[
								"Invalid Options:",
								"- 'allowInlineConfig' must be a boolean.",
								"- 'baseConfig' must be an object or null.",
								"- 'cache' must be a boolean.",
								"- 'cacheLocation' must be a non-empty string.",
								"- 'cwd' must be an absolute path.",
								"- 'errorOnUnmatchedPattern' must be a boolean.",
								"- 'fix' must be a boolean or a function.",
								'- \'fixTypes\' must be an array of any of "directive", "problem", "suggestion", and "layout".',
								"- 'globInputPaths' must be a boolean.",
								"- 'ignore' must be a boolean.",
								"- 'ignorePatterns' must be an array of non-empty strings or null.",
								"- 'overrideConfig' must be an object or null.",
								"- 'overrideConfigFile' must be a non-empty string, null, or true.",
								"- 'plugins' must be an object or null.",
								"- 'warnIgnored' must be a boolean.",
								"- 'ruleFilter' must be a function.",
							].join("\n"),
						),
						"u",
					),
				);
			});

			it("should throw readable messages if 'ignorePatterns' is not an array of non-empty strings.", () => {
				const invalidIgnorePatterns = [
					() => {},
					false,
					{},
					"",
					"foo",
					[[]],
					[() => {}],
					[false],
					[{}],
					[""],
					["foo", ""],
					["foo", "", "bar"],
					["foo", false, "bar"],
				];

				invalidIgnorePatterns.forEach(ignorePatterns => {
					assert.throws(
						() => new ESLint({ ignorePatterns, flags }),
						new RegExp(
							escapeStringRegExp(
								[
									"Invalid Options:",
									"- 'ignorePatterns' must be an array of non-empty strings or null.",
								].join("\n"),
							),
							"u",
						),
					);
				});
			});

			it("should throw readable messages if 'plugins' option contains empty key", () => {
				assert.throws(
					() =>
						new ESLint({
							flags,
							plugins: {
								"eslint-plugin-foo": {},
								"eslint-plugin-bar": {},
								"": {},
							},
						}),
					new RegExp(
						escapeStringRegExp(
							[
								"Invalid Options:",
								"- 'plugins' must not include an empty string.",
							].join("\n"),
						),
						"u",
					),
				);
			});

			it("should warn if .eslintignore file is present", async () => {
				const cwd = getFixturePath("ignored-paths");

				sinon.restore();
				const emitESLintIgnoreWarningStub = sinon.stub(
					WarningService.prototype,
					"emitESLintIgnoreWarning",
				);

				// eslint-disable-next-line no-new -- for testing purpose only
				new ESLint({ cwd, flags });

				assert(
					emitESLintIgnoreWarningStub.calledOnce,
					"calls `warningService.emitESLintIgnoreWarning()` once",
				);
			});
		});

		describe("hasFlag", () => {
			/** @type {InstanceType<ESLint>} */
			let eslint;

			let processStub;

			beforeEach(() => {
				sinon.restore();
				processStub = sinon
					.stub(process, "emitWarning")
					.withArgs(
						sinon.match.any,
						sinon.match(/^ESLintInactiveFlag_/u),
					)
					.returns();
			});

			afterEach(() => {
				delete process.env.ESLINT_FLAGS;
			});

			it("should return true if the flag is present and active", () => {
				eslint = new ESLint({
					cwd: getFixturePath(),
					flags: ["test_only"],
				});

				assert.strictEqual(eslint.hasFlag("test_only"), true);
			});

			it("should return true if the flag is present and active with ESLINT_FLAGS", () => {
				process.env.ESLINT_FLAGS = "test_only";
				eslint = new ESLint({
					cwd: getFixturePath(),
				});
				assert.strictEqual(eslint.hasFlag("test_only"), true);
			});

			it("should merge flags passed through API with flags passed through ESLINT_FLAGS", () => {
				process.env.ESLINT_FLAGS = "test_only";
				eslint = new ESLint({
					cwd: getFixturePath(),
					flags: ["test_only_2"],
				});
				assert.strictEqual(eslint.hasFlag("test_only"), true);
				assert.strictEqual(eslint.hasFlag("test_only_2"), true);
			});

			it("should return true for multiple flags in ESLINT_FLAGS if the flag is present and active and one is duplicated in the API", () => {
				process.env.ESLINT_FLAGS = "test_only,test_only_2";

				eslint = new ESLint({
					cwd: getFixturePath(),
					flags: ["test_only"], // intentional duplication
				});

				assert.strictEqual(eslint.hasFlag("test_only"), true);
				assert.strictEqual(eslint.hasFlag("test_only_2"), true);
			});

			it("should return true for multiple flags in ESLINT_FLAGS if the flag is present and active and there is leading and trailing white space", () => {
				process.env.ESLINT_FLAGS = " test_only, test_only_2 ";

				eslint = new ESLint({
					cwd: getFixturePath(),
				});

				assert.strictEqual(eslint.hasFlag("test_only"), true);
				assert.strictEqual(eslint.hasFlag("test_only_2"), true);
			});

			it("should return true for the replacement flag if an inactive flag that has been replaced is used", () => {
				eslint = new ESLint({
					cwd: getFixturePath(),
					flags: ["test_only_replaced"],
				});

				assert.strictEqual(eslint.hasFlag("test_only"), true);
				assert.strictEqual(
					processStub.callCount,
					1,
					"calls `process.emitWarning()` for flags once",
				);
				assert.deepStrictEqual(processStub.getCall(0).args, [
					"The flag 'test_only_replaced' is inactive: This flag has been renamed 'test_only' to reflect its stabilization. Please use 'test_only' instead.",
					"ESLintInactiveFlag_test_only_replaced",
				]);
			});

			it("should return false if an inactive flag whose feature is enabled by default is used", () => {
				eslint = new ESLint({
					cwd: getFixturePath(),
					flags: ["test_only_enabled_by_default"],
				});

				assert.strictEqual(
					eslint.hasFlag("test_only_enabled_by_default"),
					false,
				);
				assert.strictEqual(
					processStub.callCount,
					1,
					"calls `process.emitWarning()` for flags once",
				);
				assert.deepStrictEqual(processStub.getCall(0).args, [
					"The flag 'test_only_enabled_by_default' is inactive: This feature is now enabled by default.",
					"ESLintInactiveFlag_test_only_enabled_by_default",
				]);
			});

			it("should throw an error if an inactive flag whose feature has been abandoned is used", () => {
				assert.throws(() => {
					eslint = new ESLint({
						cwd: getFixturePath(),
						flags: ["test_only_abandoned"],
					});
				}, /The flag 'test_only_abandoned' is inactive: This feature has been abandoned/u);
			});

			it("should throw an error if an inactive flag whose feature has been abandoned is used in ESLINT_FLAGS", () => {
				process.env.ESLINT_FLAGS = "test_only_abandoned";
				assert.throws(() => {
					eslint = new ESLint({
						cwd: getFixturePath(),
					});
				}, /The flag 'test_only_abandoned' is inactive: This feature has been abandoned/u);
			});

			it("should throw an error if the flag is unknown", () => {
				assert.throws(() => {
					eslint = new ESLint({
						cwd: getFixturePath(),
						flags: ["foo_bar"],
					});
				}, /Unknown flag 'foo_bar'/u);
			});

			it("should throw an error if the flag is unknown in ESLINT_FLAGS", () => {
				process.env.ESLINT_FLAGS = "foo_bar";
				assert.throws(() => {
					eslint = new ESLint({
						cwd: getFixturePath(),
					});
				}, /Unknown flag 'foo_bar'/u);
			});

			it("should return false if the flag is not present", () => {
				eslint = new ESLint({ cwd: getFixturePath() });

				assert.strictEqual(eslint.hasFlag("x_feature"), false);
			});

			// TODO: Remove in ESLint v10 when the flag is removed
			it("should not throw an error if the flag 'unstable_ts_config' is used", () => {
				eslint = new ESLint({
					flags: [...flags, "unstable_ts_config"],
				});

				assert.strictEqual(eslint.hasFlag("unstable_ts_config"), false);
				assert.strictEqual(
					processStub.callCount,
					1,
					"calls `process.emitWarning()` for flags once",
				);
				assert.deepStrictEqual(processStub.getCall(0).args, [
					"The flag 'unstable_ts_config' is inactive: This feature is now enabled by default.",
					"ESLintInactiveFlag_unstable_ts_config",
				]);
			});
		});

		describe("lintText()", () => {
			/** @type {InstanceType<ESLint>} */
			let eslint;

			it("should report the total and per file errors when using local cwd eslint.config.js", async () => {
				eslint = new ESLint({
					flags,
					cwd: __dirname,
				});

				const results = await eslint.lintText("var foo = 'bar';");

				assert.strictEqual(results.length, 1);
				assert.strictEqual(results[0].messages.length, 4);
				assert.strictEqual(results[0].messages[0].ruleId, "no-var");
				assert.strictEqual(
					results[0].messages[1].ruleId,
					"no-unused-vars",
				);
				assert.strictEqual(results[0].messages[2].ruleId, "quotes");
				assert.strictEqual(results[0].messages[3].ruleId, "eol-last");
				assert.strictEqual(results[0].fixableErrorCount, 3);
				assert.strictEqual(results[0].fixableWarningCount, 0);
				assert.strictEqual(results[0].usedDeprecatedRules.length, 2);
				assert.strictEqual(
					results[0].usedDeprecatedRules[0].ruleId,
					"quotes",
				);
				assert.strictEqual(
					results[0].usedDeprecatedRules[1].ruleId,
					"eol-last",
				);
				assert.strictEqual(results[0].suppressedMessages.length, 0);
			});

			it("should report the total and per file warnings when not using a config file", async () => {
				eslint = new ESLint({
					flags,
					overrideConfig: {
						rules: {
							quotes: 1,
							"no-var": 1,
							"eol-last": 1,
							"no-unused-vars": 1,
						},
					},
					overrideConfigFile: true,
				});
				const results = await eslint.lintText("var foo = 'bar';");

				assert.strictEqual(results.length, 1);
				assert.strictEqual(results[0].messages.length, 4);
				assert.strictEqual(results[0].messages[0].ruleId, "no-var");
				assert.strictEqual(
					results[0].messages[1].ruleId,
					"no-unused-vars",
				);
				assert.strictEqual(results[0].messages[2].ruleId, "quotes");
				assert.strictEqual(results[0].messages[3].ruleId, "eol-last");
				assert.strictEqual(results[0].fixableErrorCount, 0);
				assert.strictEqual(results[0].fixableWarningCount, 3);
				assert.strictEqual(results[0].usedDeprecatedRules.length, 2);
				assert.strictEqual(
					results[0].usedDeprecatedRules[0].ruleId,
					"quotes",
				);
				assert.strictEqual(
					results[0].usedDeprecatedRules[1].ruleId,
					"eol-last",
				);
				assert.strictEqual(results[0].suppressedMessages.length, 0);
			});

			it("should report one message when using specific config file", async () => {
				eslint = new ESLint({
					flags,
					overrideConfigFile:
						"fixtures/configurations/quotes-error.js",
					cwd: getFixturePath(".."),
				});
				const results = await eslint.lintText("var foo = 'bar';");

				assert.strictEqual(results.length, 1);
				assert.strictEqual(results[0].messages.length, 1);
				assert.strictEqual(results[0].messages[0].ruleId, "quotes");
				assert.strictEqual(results[0].messages[0].output, void 0);
				assert.strictEqual(results[0].errorCount, 1);
				assert.strictEqual(results[0].fixableErrorCount, 1);
				assert.strictEqual(results[0].warningCount, 0);
				assert.strictEqual(results[0].fatalErrorCount, 0);
				assert.strictEqual(results[0].usedDeprecatedRules.length, 1);
				assert.strictEqual(
					results[0].usedDeprecatedRules[0].ruleId,
					"quotes",
				);
				assert.strictEqual(results[0].suppressedMessages.length, 0);
			});

			it("should report the filename when passed in", async () => {
				eslint = new ESLint({
					flags,
					ignore: false,
					cwd: getFixturePath(),
				});
				const options = { filePath: "test.js" };
				const results = await eslint.lintText(
					"var foo = 'bar';",
					options,
				);

				assert.strictEqual(
					results[0].filePath,
					getFixturePath("test.js"),
				);
			});

			it("should return a warning when given a filename by --stdin-filename in excluded files list if warnIgnored is true", async () => {
				eslint = new ESLint({
					flags,
					cwd: getFixturePath(".."),
					overrideConfigFile:
						"fixtures/eslint.config-with-ignores.js",
				});

				const options = {
					filePath: "fixtures/passing.js",
					warnIgnored: true,
				};
				const results = await eslint.lintText(
					"var bar = foo;",
					options,
				);

				assert.strictEqual(results.length, 1);
				assert.strictEqual(
					results[0].filePath,
					getFixturePath("passing.js"),
				);
				assert.strictEqual(results[0].messages[0].severity, 1);
				assert.strictEqual(
					results[0].messages[0].message,
					'File ignored because of a matching ignore pattern. Use "--no-ignore" to disable file ignore settings or use "--no-warn-ignored" to suppress this warning.',
				);
				assert.strictEqual(results[0].messages[0].output, void 0);
				assert.strictEqual(results[0].errorCount, 0);
				assert.strictEqual(results[0].warningCount, 1);
				assert.strictEqual(results[0].fatalErrorCount, 0);
				assert.strictEqual(results[0].fixableErrorCount, 0);
				assert.strictEqual(results[0].fixableWarningCount, 0);
				assert.strictEqual(results[0].usedDeprecatedRules.length, 0);
				assert.strictEqual(results[0].suppressedMessages.length, 0);
			});

			it("should return a warning when given a filename without a matching config by --stdin-filename if warnIgnored is true", async () => {
				eslint = new ESLint({
					flags,
					cwd: getFixturePath(".."),
					overrideConfigFile: true,
				});

				const options = {
					filePath: "fixtures/file.ts",
					warnIgnored: true,
				};
				const results = await eslint.lintText(
					"type foo = { bar: string };",
					options,
				);

				assert.strictEqual(results.length, 1);
				assert.strictEqual(
					results[0].filePath,
					getFixturePath("file.ts"),
				);
				assert.strictEqual(results[0].messages[0].severity, 1);
				assert.strictEqual(
					results[0].messages[0].message,
					"File ignored because no matching configuration was supplied.",
				);
				assert.strictEqual(results[0].messages[0].output, void 0);
				assert.strictEqual(results[0].errorCount, 0);
				assert.strictEqual(results[0].warningCount, 1);
				assert.strictEqual(results[0].fatalErrorCount, 0);
				assert.strictEqual(results[0].fixableErrorCount, 0);
				assert.strictEqual(results[0].fixableWarningCount, 0);
				assert.strictEqual(results[0].usedDeprecatedRules.length, 0);
				assert.strictEqual(results[0].suppressedMessages.length, 0);
			});

			it("should return a warning when given a filename outside the base path by --stdin-filename if warnIgnored is true", async () => {
				eslint = new ESLint({
					flags,
					cwd: getFixturePath(),
					overrideConfigFile: true,
				});

				const options = { filePath: "../file.js", warnIgnored: true };
				const results = await eslint.lintText(
					"var bar = foo;",
					options,
				);

				assert.strictEqual(results.length, 1);
				assert.strictEqual(
					results[0].filePath,
					getFixturePath("../file.js"),
				);
				assert.strictEqual(results[0].messages[0].severity, 1);
				assert.strictEqual(
					results[0].messages[0].message,
					"File ignored because outside of base path.",
				);
				assert.strictEqual(results[0].messages[0].output, void 0);
				assert.strictEqual(results[0].errorCount, 0);
				assert.strictEqual(results[0].warningCount, 1);
				assert.strictEqual(results[0].fatalErrorCount, 0);
				assert.strictEqual(results[0].fixableErrorCount, 0);
				assert.strictEqual(results[0].fixableWarningCount, 0);
				assert.strictEqual(results[0].usedDeprecatedRules.length, 0);
				assert.strictEqual(results[0].suppressedMessages.length, 0);
			});

			if (os.platform() === "win32") {
				it("should return a warning when given a filename on a different drive by --stdin-filename if warnIgnored is true on Windows", async () => {
					const currentRoot = path.resolve("\\");
					const otherRoot = currentRoot === "A:\\" ? "B:\\" : "A:\\";

					eslint = new ESLint({
						flags,
						cwd: getFixturePath(),
						overrideConfigFile: true,
					});

					const filePath = `${otherRoot}file.js`;
					const options = { filePath, warnIgnored: true };
					const results = await eslint.lintText(
						"var bar = foo;",
						options,
					);

					assert.strictEqual(results.length, 1);
					assert.strictEqual(results[0].filePath, filePath);
					assert.strictEqual(results[0].messages[0].severity, 1);
					assert.strictEqual(
						results[0].messages[0].message,
						"File ignored because outside of base path.",
					);
					assert.strictEqual(results[0].messages[0].output, void 0);
					assert.strictEqual(results[0].errorCount, 0);
					assert.strictEqual(results[0].warningCount, 1);
					assert.strictEqual(results[0].fatalErrorCount, 0);
					assert.strictEqual(results[0].fixableErrorCount, 0);
					assert.strictEqual(results[0].fixableWarningCount, 0);
					assert.strictEqual(
						results[0].usedDeprecatedRules.length,
						0,
					);
					assert.strictEqual(results[0].suppressedMessages.length, 0);
				});
			}

			it("should return a warning when given a filename by --stdin-filename in excluded files list if constructor warnIgnored is false, but lintText warnIgnored is true", async () => {
				eslint = new ESLint({
					flags,
					cwd: getFixturePath(".."),
					overrideConfigFile:
						"fixtures/eslint.config-with-ignores.js",
					warnIgnored: false,
				});

				const options = {
					filePath: "fixtures/passing.js",
					warnIgnored: true,
				};
				const results = await eslint.lintText(
					"var bar = foo;",
					options,
				);

				assert.strictEqual(results.length, 1);
				assert.strictEqual(
					results[0].filePath,
					getFixturePath("passing.js"),
				);
				assert.strictEqual(results[0].messages[0].severity, 1);
				assert.strictEqual(
					results[0].messages[0].message,
					'File ignored because of a matching ignore pattern. Use "--no-ignore" to disable file ignore settings or use "--no-warn-ignored" to suppress this warning.',
				);
				assert.strictEqual(results[0].messages[0].output, void 0);
				assert.strictEqual(results[0].errorCount, 0);
				assert.strictEqual(results[0].warningCount, 1);
				assert.strictEqual(results[0].fatalErrorCount, 0);
				assert.strictEqual(results[0].fixableErrorCount, 0);
				assert.strictEqual(results[0].fixableWarningCount, 0);
				assert.strictEqual(results[0].usedDeprecatedRules.length, 0);
				assert.strictEqual(results[0].suppressedMessages.length, 0);
			});

			it("should not return a warning when given a filename by --stdin-filename in excluded files list if warnIgnored is false", async () => {
				eslint = new ESLint({
					flags,
					cwd: getFixturePath(".."),
					overrideConfigFile:
						"fixtures/eslint.config-with-ignores.js",
				});
				const options = {
					filePath: "fixtures/passing.js",
					warnIgnored: false,
				};

				// intentional parsing error
				const results = await eslint.lintText(
					"va r bar = foo;",
					options,
				);

				// should not report anything because the file is ignored
				assert.strictEqual(results.length, 0);
			});

			it("should not return a warning when given a filename by --stdin-filename in excluded files list if constructor warnIgnored is false", async () => {
				eslint = new ESLint({
					flags,
					cwd: getFixturePath(".."),
					overrideConfigFile:
						"fixtures/eslint.config-with-ignores.js",
					warnIgnored: false,
				});
				const options = { filePath: "fixtures/passing.js" };
				const results = await eslint.lintText(
					"var bar = foo;",
					options,
				);

				// should not report anything because the warning is suppressed
				assert.strictEqual(results.length, 0);
			});

			it("should throw an error when there's no config file for a stdin file", () => {
				eslint = new ESLint({
					flags,
					cwd: "/",
				});
				const options = { filePath: "fixtures/passing.js" };

				return assert.rejects(
					() => eslint.lintText("var bar = foo;", options),
					/Could not find config file/u,
				);
			});

			it("should show excluded file warnings by default", async () => {
				eslint = new ESLint({
					flags,
					cwd: getFixturePath(".."),
					overrideConfigFile:
						"fixtures/eslint.config-with-ignores.js",
				});
				const options = { filePath: "fixtures/passing.js" };
				const results = await eslint.lintText(
					"var bar = foo;",
					options,
				);

				assert.strictEqual(results.length, 1);
				assert.strictEqual(
					results[0].messages[0].message,
					'File ignored because of a matching ignore pattern. Use "--no-ignore" to disable file ignore settings or use "--no-warn-ignored" to suppress this warning.',
				);
			});

			it("should return a message when given a filename by --stdin-filename in excluded files list and ignore is off", async () => {
				eslint = new ESLint({
					flags,
					cwd: getFixturePath(".."),
					ignore: false,
					overrideConfigFile:
						"fixtures/eslint.config-with-ignores.js",
					overrideConfig: {
						rules: {
							"no-undef": 2,
						},
					},
				});
				const options = { filePath: "fixtures/passing.js" };
				const results = await eslint.lintText(
					"var bar = foo;",
					options,
				);

				assert.strictEqual(results.length, 1);
				assert.strictEqual(
					results[0].filePath,
					getFixturePath("passing.js"),
				);
				assert.strictEqual(results[0].messages[0].ruleId, "no-undef");
				assert.strictEqual(results[0].messages[0].severity, 2);
				assert.strictEqual(results[0].messages[0].output, void 0);
				assert.strictEqual(results[0].suppressedMessages.length, 0);
			});

			it("should return a message and fixed text when in fix mode", async () => {
				eslint = new ESLint({
					flags,
					overrideConfigFile: true,
					fix: true,
					overrideConfig: {
						rules: {
							semi: 2,
						},
					},
					ignore: false,
					cwd: getFixturePath(),
				});
				const options = { filePath: "passing.js" };
				const results = await eslint.lintText("var bar = foo", options);

				assert.deepStrictEqual(results, [
					{
						filePath: getFixturePath("passing.js"),
						messages: [],
						suppressedMessages: [],
						errorCount: 0,
						warningCount: 0,
						fatalErrorCount: 0,
						fixableErrorCount: 0,
						fixableWarningCount: 0,
						output: "var bar = foo;",
						usedDeprecatedRules: [
							{
								ruleId: "semi",
								replacedBy: ["@stylistic/semi"],
								info: coreRules.get("semi").meta.deprecated,
							},
						],
					},
				]);
			});

			it("should return a message and omit fixed text when in fix mode and fixes aren't done", async () => {
				eslint = new ESLint({
					flags,
					overrideConfigFile: true,
					fix: true,
					overrideConfig: {
						rules: {
							"no-undef": 2,
						},
					},
					ignore: false,
					cwd: getFixturePath(),
				});
				const options = { filePath: "passing.js" };
				const results = await eslint.lintText("var bar = foo", options);

				assert.deepStrictEqual(results, [
					{
						filePath: getFixturePath("passing.js"),
						messages: [
							{
								ruleId: "no-undef",
								severity: 2,
								messageId: "undef",
								message: "'foo' is not defined.",
								line: 1,
								column: 11,
								endLine: 1,
								endColumn: 14,
								nodeType: "Identifier",
							},
						],
						suppressedMessages: [],
						errorCount: 1,
						warningCount: 0,
						fatalErrorCount: 0,
						fixableErrorCount: 0,
						fixableWarningCount: 0,
						source: "var bar = foo",
						usedDeprecatedRules: [],
					},
				]);
			});

			it("should not delete code if there is a syntax error after trying to autofix.", async () => {
				eslint = eslintWithPlugins({
					flags,
					overrideConfigFile: true,
					fix: true,
					overrideConfig: {
						rules: {
							"example/make-syntax-error": "error",
						},
					},
					ignore: false,
					cwd: getFixturePath("."),
				});
				const options = { filePath: "test.js" };
				const results = await eslint.lintText("var bar = foo", options);

				assert.deepStrictEqual(results, [
					{
						filePath: getFixturePath("test.js"),
						messages: [
							{
								ruleId: null,
								fatal: true,
								severity: 2,
								message: "Parsing error: Unexpected token is",
								line: 1,
								column: 19,
								nodeType: null,
							},
						],
						suppressedMessages: [],
						errorCount: 1,
						warningCount: 0,
						fatalErrorCount: 1,
						fixableErrorCount: 0,
						fixableWarningCount: 0,
						output: "var bar = foothis is a syntax error.",
						usedDeprecatedRules: [],
					},
				]);
			});

			it("should not crash even if there are any syntax error since the first time.", async () => {
				eslint = eslintWithPlugins({
					flags,
					overrideConfigFile: true,
					fix: true,
					overrideConfig: {
						rules: {
							"example/make-syntax-error": "error",
						},
					},
					ignore: false,
					cwd: getFixturePath(),
				});
				const options = { filePath: "test.js" };
				const results = await eslint.lintText("var bar =", options);

				assert.deepStrictEqual(results, [
					{
						filePath: getFixturePath("test.js"),
						messages: [
							{
								ruleId: null,
								fatal: true,
								severity: 2,
								message: "Parsing error: Unexpected token",
								line: 1,
								column: 10,
								nodeType: null,
							},
						],
						suppressedMessages: [],
						errorCount: 1,
						warningCount: 0,
						fatalErrorCount: 1,
						fixableErrorCount: 0,
						fixableWarningCount: 0,
						source: "var bar =",
						usedDeprecatedRules: [],
					},
				]);
			});

			it("should return source code of file in `source` property when errors are present", async () => {
				eslint = new ESLint({
					flags,
					overrideConfigFile: true,
					overrideConfig: {
						rules: { semi: 2 },
					},
				});
				const results = await eslint.lintText("var foo = 'bar'");

				assert.strictEqual(results[0].source, "var foo = 'bar'");
			});

			it("should return source code of file in `source` property when warnings are present", async () => {
				eslint = new ESLint({
					flags,
					overrideConfigFile: true,
					overrideConfig: {
						rules: { semi: 1 },
					},
				});
				const results = await eslint.lintText("var foo = 'bar'");

				assert.strictEqual(results[0].source, "var foo = 'bar'");
			});

			it("should not return a `source` property when no errors or warnings are present", async () => {
				eslint = new ESLint({
					flags,
					overrideConfigFile: true,
					overrideConfig: {
						rules: { semi: 2 },
					},
				});
				const results = await eslint.lintText("var foo = 'bar';");

				assert.strictEqual(results[0].messages.length, 0);
				assert.strictEqual(results[0].source, void 0);
				assert.strictEqual(results[0].suppressedMessages.length, 0);
			});

			it("should not return a `source` property when fixes are applied", async () => {
				eslint = new ESLint({
					flags,
					overrideConfigFile: true,
					fix: true,
					overrideConfig: {
						rules: {
							semi: 2,
							"no-unused-vars": 2,
						},
					},
				});
				const results = await eslint.lintText("var msg = 'hi' + foo\n");

				assert.strictEqual(results[0].source, void 0);
				assert.strictEqual(
					results[0].output,
					"var msg = 'hi' + foo;\n",
				);
			});

			it("should return a `source` property when a parsing error has occurred", async () => {
				eslint = new ESLint({
					flags,
					overrideConfigFile: true,
					overrideConfig: {
						rules: { eqeqeq: 2 },
					},
				});
				const results = await eslint.lintText(
					"var bar = foothis is a syntax error.\n return bar;",
				);

				assert.deepStrictEqual(results, [
					{
						filePath: "<text>",
						messages: [
							{
								ruleId: null,
								fatal: true,
								severity: 2,
								message: "Parsing error: Unexpected token is",
								line: 1,
								column: 19,
								nodeType: null,
							},
						],
						suppressedMessages: [],
						errorCount: 1,
						warningCount: 0,
						fatalErrorCount: 1,
						fixableErrorCount: 0,
						fixableWarningCount: 0,
						source: "var bar = foothis is a syntax error.\n return bar;",
						usedDeprecatedRules: [],
					},
				]);
			});

			// https://github.com/eslint/eslint/issues/5547
			it("should respect default ignore rules (ignoring node_modules), even with --no-ignore", async () => {
				eslint = new ESLint({
					flags,
					cwd: getFixturePath(),
					ignore: false,
				});
				const results = await eslint.lintText("var bar = foo;", {
					filePath: "node_modules/passing.js",
					warnIgnored: true,
				});
				const expectedMsg =
					'File ignored by default because it is located under the node_modules directory. Use ignore pattern "!**/node_modules/" to disable file ignore settings or use "--no-warn-ignored" to suppress this warning.';

				assert.strictEqual(results.length, 1);
				assert.strictEqual(
					results[0].filePath,
					getFixturePath("node_modules/passing.js"),
				);
				assert.strictEqual(results[0].messages[0].message, expectedMsg);
				assert.strictEqual(results[0].suppressedMessages.length, 0);
			});

			it("should warn when deprecated rules are found in a config", async () => {
				eslint = new ESLint({
					flags,
					cwd: originalDir,
					overrideConfigFile:
						"tests/fixtures/cli-engine/deprecated-rule-config/eslint.config.js",
				});
				const [result] = await eslint.lintText("foo");

				assert.deepStrictEqual(result.usedDeprecatedRules, [
					{
						ruleId: "indent-legacy",
						replacedBy: ["@stylistic/indent"],
						info: coreRules.get("indent-legacy")?.meta.deprecated,
					},
				]);
			});

			it("should throw if eslint.config.js file is not present", async () => {
				eslint = new ESLint({
					flags,
					cwd: getFixturePath(".."),
				});
				await assert.rejects(
					() => eslint.lintText("var foo = 'bar';"),
					/Could not find config file/u,
				);
			});

			it("should throw if eslint.config.js file is not present even if overrideConfig was passed", async () => {
				eslint = new ESLint({
					flags,
					cwd: getFixturePath(".."),
					overrideConfig: {
						rules: {
							"no-unused-vars": 2,
						},
					},
				});
				await assert.rejects(
					() => eslint.lintText("var foo = 'bar';"),
					/Could not find config file/u,
				);
			});

			it("should not throw if eslint.config.js file is not present and overrideConfigFile is `true`", async () => {
				eslint = new ESLint({
					flags,
					cwd: getFixturePath(".."),
					overrideConfigFile: true,
				});
				await eslint.lintText("var foo = 'bar';");
			});

			it("should not throw if eslint.config.js file is not present and overrideConfigFile is path to a config file", async () => {
				eslint = new ESLint({
					flags,
					cwd: getFixturePath(".."),
					overrideConfigFile:
						"fixtures/configurations/quotes-error.js",
				});
				await eslint.lintText("var foo = 'bar';");
			});

			it("should throw if overrideConfigFile is path to a file that doesn't exist", async () => {
				eslint = new ESLint({
					flags,
					cwd: getFixturePath(""),
					overrideConfigFile: "does-not-exist.js",
				});
				await assert.rejects(
					() => eslint.lintText("var foo = 'bar';"),
					{ code: "ENOENT" },
				);
			});

			it("should throw if non-string value is given to 'code' parameter", async () => {
				eslint = new ESLint({ flags });
				await assert.rejects(
					() => eslint.lintText(100),
					/'code' must be a string/u,
				);
			});

			it("should throw if non-object value is given to 'options' parameter", async () => {
				eslint = new ESLint({ flags });
				await assert.rejects(
					() => eslint.lintText("var a = 0", "foo.js"),
					/'options' must be an object, null, or undefined/u,
				);
			});

			it("should throw if 'options' argument contains unknown key", async () => {
				eslint = new ESLint({ flags });
				await assert.rejects(
					() => eslint.lintText("var a = 0", { filename: "foo.js" }),
					/'options' must not include the unknown option\(s\): filename/u,
				);
			});

			it("should throw if non-string value is given to 'options.filePath' option", async () => {
				eslint = new ESLint({ flags });
				await assert.rejects(
					() => eslint.lintText("var a = 0", { filePath: "" }),
					/'options.filePath' must be a non-empty string or undefined/u,
				);
			});

			it("should throw if non-boolean value is given to 'options.warnIgnored' option", async () => {
				eslint = new ESLint({ flags });
				await assert.rejects(
					() => eslint.lintText("var a = 0", { warnIgnored: "" }),
					/'options.warnIgnored' must be a boolean or undefined/u,
				);
			});

			it("should work with config file that exports a promise", async () => {
				eslint = new ESLint({
					flags,
					cwd: getFixturePath("promise-config"),
				});
				const results = await eslint.lintText('var foo = "bar";');

				assert.strictEqual(results.length, 1);
				assert.strictEqual(results[0].messages.length, 1);
				assert.strictEqual(results[0].messages[0].severity, 2);
				assert.strictEqual(results[0].messages[0].ruleId, "quotes");
			});

			describe("Alternate config files", () => {
				it("should find eslint.config.mjs when present", async () => {
					const cwd = getFixturePath("mjs-config");

					eslint = new ESLint({
						flags,
						cwd,
					});

					const results = await eslint.lintText("foo");

					assert.strictEqual(results.length, 1);
					assert.strictEqual(results[0].messages.length, 1);
					assert.strictEqual(results[0].messages[0].severity, 2);
					assert.strictEqual(
						results[0].messages[0].ruleId,
						"no-undef",
					);
				});

				it("should find eslint.config.cjs when present", async () => {
					const cwd = getFixturePath("cjs-config");

					eslint = new ESLint({
						flags,
						cwd,
					});

					const results = await eslint.lintText("foo");

					assert.strictEqual(results.length, 1);
					assert.strictEqual(results[0].messages.length, 1);
					assert.strictEqual(results[0].messages[0].severity, 1);
					assert.strictEqual(
						results[0].messages[0].ruleId,
						"no-undef",
					);
				});

				it("should favor eslint.config.js when eslint.config.mjs and eslint.config.cjs are present", async () => {
					const cwd = getFixturePath("js-mjs-cjs-config");

					eslint = new ESLint({
						flags,
						cwd,
					});

					const results = await eslint.lintText("foo");

					assert.strictEqual(results.length, 1);
					assert.strictEqual(results[0].messages.length, 0);
				});

				it("should favor eslint.config.mjs when eslint.config.cjs is present", async () => {
					const cwd = getFixturePath("mjs-cjs-config");

					eslint = new ESLint({
						flags,
						cwd,
					});

					const results = await eslint.lintText("foo");

					assert.strictEqual(results.length, 1);
					assert.strictEqual(results[0].messages.length, 1);
					assert.strictEqual(results[0].messages[0].severity, 2);
					assert.strictEqual(
						results[0].messages[0].ruleId,
						"no-undef",
					);
				});
			});

			describe("TypeScript config files", () => {
				JITI_VERSIONS.forEach(jitiVersion => {
					describe(`Loading TypeScript config files with ${jitiVersion}`, () => {
						if (jitiVersion !== "jiti") {
							beforeEach(() => {
								sinon
									.stub(ConfigLoader, "loadJiti")
									.callsFake(() =>
										Promise.resolve({
											createJiti:
												require(jitiVersion).createJiti,
											version: require(
												`${jitiVersion}/package.json`,
											).version,
										}),
									);
							});
						}

						it("should find and load eslint.config.ts when present", async () => {
							const cwd = getFixturePath("ts-config-files", "ts");

							eslint = new ESLint({
								cwd,
								flags,
							});

							const results = await eslint.lintText("foo");

							assert.strictEqual(results.length, 1);
							assert.strictEqual(results[0].messages.length, 1);
							assert.strictEqual(
								results[0].messages[0].severity,
								2,
							);
							assert.strictEqual(
								results[0].messages[0].ruleId,
								"no-undef",
							);
						});

						it('should load eslint.config.ts when we have "type": "commonjs" in nearest `package.json`', async () => {
							const cwd = getFixturePath(
								"ts-config-files",
								"ts",
								"with-type-commonjs",
							);

							eslint = new ESLint({
								cwd,
								flags,
							});

							const results = await eslint.lintText("foo");

							assert.strictEqual(results.length, 1);
							assert.strictEqual(results[0].messages.length, 1);
							assert.strictEqual(
								results[0].messages[0].severity,
								2,
							);
							assert.strictEqual(
								results[0].messages[0].ruleId,
								"no-undef",
							);
						});

						it('should load eslint.config.ts when we have "type": "module" in nearest `package.json`', async () => {
							const cwd = getFixturePath(
								"ts-config-files",
								"ts",
								"with-type-module",
							);

							eslint = new ESLint({
								cwd,
								flags,
							});

							const results = await eslint.lintText("foo");

							assert.strictEqual(results.length, 1);
							assert.strictEqual(results[0].messages.length, 1);
							assert.strictEqual(
								results[0].messages[0].severity,
								2,
							);
							assert.strictEqual(
								results[0].messages[0].ruleId,
								"no-undef",
							);
						});

						it("should load eslint.config.ts with const enums", async () => {
							const cwd = getFixturePath(
								"ts-config-files",
								"ts",
								"const-enums",
							);

							eslint = new ESLint({
								cwd,
								flags,
							});

							const results = await eslint.lintText("foo");

							assert.strictEqual(results.length, 1);
							assert.strictEqual(results[0].messages.length, 1);
							assert.strictEqual(
								results[0].messages[0].severity,
								2,
							);
							assert.strictEqual(
								results[0].messages[0].ruleId,
								"no-undef",
							);
						});

						it("should load eslint.config.ts with local namespace", async () => {
							const cwd = getFixturePath(
								"ts-config-files",
								"ts",
								"local-namespace",
							);

							eslint = new ESLint({
								cwd,
								flags,
							});

							const results = await eslint.lintText("foo");

							assert.strictEqual(results.length, 1);
							assert.strictEqual(results[0].messages.length, 1);
							assert.strictEqual(
								results[0].messages[0].severity,
								2,
							);
							assert.strictEqual(
								results[0].messages[0].ruleId,
								"no-undef",
							);
						});

						it("should allow passing a TS config file to `overrideConfigFile`", async () => {
							const cwd = getFixturePath(
								"ts-config-files",
								"ts",
								"custom-config",
							);

							eslint = new ESLint({
								cwd,
								flags,
								overrideConfigFile: getFixturePath(
									"ts-config-files",
									"ts",
									"custom-config",
									"eslint.custom.config.ts",
								),
							});

							const results = await eslint.lintText("foo");

							assert.strictEqual(results.length, 1);
							assert.strictEqual(results[0].messages.length, 1);
							assert.strictEqual(
								results[0].messages[0].severity,
								2,
							);
							assert.strictEqual(
								results[0].messages[0].ruleId,
								"no-undef",
							);
						});

						it("should find and load eslint.config.mts when present", async () => {
							const cwd = getFixturePath(
								"ts-config-files",
								"mts",
							);

							eslint = new ESLint({
								cwd,
								flags,
							});

							const results = await eslint.lintText("foo");

							assert.strictEqual(results.length, 1);
							assert.strictEqual(results[0].messages.length, 1);
							assert.strictEqual(
								results[0].messages[0].severity,
								2,
							);
							assert.strictEqual(
								results[0].messages[0].ruleId,
								"no-undef",
							);
						});

						it('should load eslint.config.mts when we have "type": "commonjs" in nearest `package.json`', async () => {
							const cwd = getFixturePath(
								"ts-config-files",
								"mts",
								"with-type-commonjs",
							);

							eslint = new ESLint({
								cwd,
								flags,
							});

							const results = await eslint.lintText("foo");

							assert.strictEqual(results.length, 1);
							assert.strictEqual(results[0].messages.length, 1);
							assert.strictEqual(
								results[0].messages[0].severity,
								2,
							);
							assert.strictEqual(
								results[0].messages[0].ruleId,
								"no-undef",
							);
						});

						it('should load eslint.config.mts config file when we have "type": "module" in nearest `package.json`', async () => {
							const cwd = getFixturePath(
								"ts-config-files",
								"mts",
								"with-type-module",
							);

							eslint = new ESLint({
								cwd,
								flags,
							});

							const results = await eslint.lintText("foo");

							assert.strictEqual(results.length, 1);
							assert.strictEqual(results[0].messages.length, 1);
							assert.strictEqual(
								results[0].messages[0].severity,
								2,
							);
							assert.strictEqual(
								results[0].messages[0].ruleId,
								"no-undef",
							);
						});

						it("should find and load eslint.config.cts when present", async () => {
							const cwd = getFixturePath(
								"ts-config-files",
								"cts",
							);

							eslint = new ESLint({
								cwd,
								flags,
							});

							const results = await eslint.lintText("foo");

							assert.strictEqual(results.length, 1);
							assert.strictEqual(results[0].messages.length, 1);
							assert.strictEqual(
								results[0].messages[0].severity,
								2,
							);
							assert.strictEqual(
								results[0].messages[0].ruleId,
								"no-undef",
							);
						});

						it('should load eslint.config.cts config file when we have "type": "commonjs" in nearest `package.json`', async () => {
							const cwd = getFixturePath(
								"ts-config-files",
								"cts",
								"with-type-commonjs",
							);

							eslint = new ESLint({
								cwd,
								flags,
							});

							const results = await eslint.lintText("foo");

							assert.strictEqual(results.length, 1);
							assert.strictEqual(results[0].messages.length, 1);
							assert.strictEqual(
								results[0].messages[0].severity,
								2,
							);
							assert.strictEqual(
								results[0].messages[0].ruleId,
								"no-undef",
							);
						});

						it('should load .cts config file when we have "type": "module" in nearest `package.json`', async () => {
							const cwd = getFixturePath(
								"ts-config-files",
								"cts",
								"with-type-module",
							);

							eslint = new ESLint({
								cwd,
								flags,
							});

							const results = await eslint.lintText("foo");

							assert.strictEqual(results.length, 1);
							assert.strictEqual(results[0].messages.length, 1);
							assert.strictEqual(
								results[0].messages[0].severity,
								2,
							);
							assert.strictEqual(
								results[0].messages[0].ruleId,
								"no-undef",
							);
						});

						it("should successfully load a TS config file that exports a promise", async () => {
							const cwd = getFixturePath(
								"ts-config-files",
								"ts",
								"exports-promise",
							);

							eslint = new ESLint({
								cwd,
								flags,
							});

							const results = await eslint.lintText("foo;");

							assert.strictEqual(results.length, 1);
							assert.strictEqual(results[0].messages.length, 1);
							assert.strictEqual(
								results[0].messages[0].severity,
								2,
							);
							assert.strictEqual(
								results[0].messages[0].ruleId,
								"no-undef",
							);
						});

						it("should load a CommonJS TS config file that exports undefined with a helpful warning message", async () => {
							sinon.restore();

							const cwd = getFixturePath("ts-config-files", "ts");
							const processStub = sinon.stub(
								process,
								"emitWarning",
							);

							eslint = new ESLint({
								cwd,
								flags,
								overrideConfigFile:
									"eslint.undefined.config.ts",
							});

							await eslint.lintText("foo");

							assert.strictEqual(
								processStub.callCount,
								1,
								"calls `process.emitWarning()` once",
							);
							assert.strictEqual(
								processStub.getCall(0).args[1],
								"ESLintEmptyConfigWarning",
							);
						});
					});
				});

				it("should fail to load a TS config file if jiti is not installed", async () => {
					sinon.stub(ConfigLoader, "loadJiti").rejects();

					const cwd = getFixturePath("ts-config-files", "ts");

					eslint = new ESLint({
						cwd,
						flags,
					});

					await assert.rejects(eslint.lintText("foo();"), {
						message:
							"The 'jiti' library is required for loading TypeScript configuration files. Make sure to install it.",
					});
				});

				it("should fail to load a TS config file if an outdated version of jiti is installed", async () => {
					sinon
						.stub(ConfigLoader, "loadJiti")
						.resolves({ createJiti: void 0, version: "1.21.7" });

					const cwd = getFixturePath("ts-config-files", "ts");

					eslint = new ESLint({
						cwd,
						flags,
					});

					await assert.rejects(eslint.lintText("foo();"), {
						message:
							"You are using an outdated version of the 'jiti' library. Please update to the latest version of 'jiti' to ensure compatibility and access to the latest features.",
					});
				});

				it("should handle jiti interopDefault edge cases", async () => {
					const cwd = getFixturePath(
						"ts-config-files",
						"ts",
						"jiti-interopDefault",
					);

					await fsp.writeFile(
						path.join(cwd, "eslint.config.ts"),
						`
						import plugin from "./plugin";

						export default plugin.configs.recommended;

						// Autogenerated on ${new Date().toISOString()}.`,
					);

					eslint = new ESLint({
						cwd,
						flags,
					});

					const results = await eslint.lintText("foo");

					assert.strictEqual(results.length, 1);
					assert.strictEqual(results[0].messages.length, 1);
					assert.strictEqual(results[0].messages[0].severity, 2);
					assert.strictEqual(
						results[0].messages[0].ruleId,
						"no-undef",
					);
				});

				// eslint-disable-next-line n/no-unsupported-features/node-builtins -- it's still an experimental feature.
				(typeof process.features.typescript === "string"
					? describe
					: describe.skip)(
					"Loading TypeScript config files natively",
					() => {
						beforeEach(() => {
							sinon.stub(ConfigLoader, "loadJiti").rejects();
						});

						const cwd = getFixturePath(
							"ts-config-files",
							"ts",
							"native",
						);

						const overrideConfigFile = "eslint.config.ts";

						it("should load a TS config file when --experimental-strip-types is enabled", async () => {
							const configFileContent = `import type { FlatConfig } from "./helper.ts";\nexport default ${JSON.stringify(
								[{ rules: { "no-undef": 2 } }],
								null,
								2,
							)} satisfies FlatConfig[];`;

							const teardown = createCustomTeardown({
								cwd,
								files: {
									[overrideConfigFile]: configFileContent,
									"foo.js": "foo;",
									"helper.ts":
										'import type { Linter } from "eslint";\nexport type FlatConfig = Linter.Config;\n',
								},
							});

							await teardown.prepare();

							eslint = new ESLint({
								cwd,
								overrideConfigFile,
								flags: nativeTSConfigFileFlags,
							});

							const results = await eslint.lintText("foo;");

							assert.strictEqual(results.length, 1);
							assert.strictEqual(results[0].messages.length, 1);
							assert.strictEqual(
								results[0].messages[0].severity,
								2,
							);
							assert.strictEqual(
								results[0].messages[0].ruleId,
								"no-undef",
							);
						});

						// eslint-disable-next-line n/no-unsupported-features/node-builtins -- it's still an experimental feature.
						(process.features.typescript === "transform"
							? it
							: it.skip)(
							"should load a TS config file when --experimental-transform-types is enabled",
							async () => {
								const configFileContent =
									'import { ESLintNameSpace } from "./helper.ts";\nexport default [ { rules: { "no-undef": ESLintNameSpace.StringSeverity.Error } }];\n';

								const teardown = createCustomTeardown({
									cwd,
									files: {
										[overrideConfigFile]: configFileContent,
										"foo.js": "foo;",
										"helper.ts":
											'export namespace ESLintNameSpace {\n  export const enum StringSeverity {\n    "Off" = "off",\n    "Warn" = "warn",\n    "Error" = "error",\n  }\n}\n',
									},
								});

								await teardown.prepare();

								eslint = new ESLint({
									cwd,
									overrideConfigFile,
									flags: nativeTSConfigFileFlags,
								});

								const results = await eslint.lintText("foo;");

								assert.strictEqual(results.length, 1);
								assert.strictEqual(
									results[0].messages.length,
									1,
								);
								assert.strictEqual(
									results[0].messages[0].severity,
									2,
								);
								assert.strictEqual(
									results[0].messages[0].ruleId,
									"no-undef",
								);
							},
						);
					},
				);
			});

			it("should pass BOM through processors", async () => {
				eslint = new ESLint({
					overrideConfigFile: true,
					overrideConfig: [
						{
							files: ["**/*.myjs"],
							processor: {
								preprocess(text, filename) {
									return [{ text, filename }];
								},
								postprocess(messages) {
									return messages.flat();
								},
								supportsAutofix: true,
							},
							rules: {
								"unicode-bom": ["error", "never"],
							},
						},
					],
					cwd: path.join(fixtureDir),
				});
				const results = await eslint.lintText(
					"\uFEFFvar foo = 'bar';",
					{ filePath: "test.myjs" },
				);

				assert.strictEqual(results.length, 1);
				assert.strictEqual(results[0].messages.length, 1);
				assert.strictEqual(results[0].messages[0].severity, 2);
				assert.strictEqual(
					results[0].messages[0].ruleId,
					"unicode-bom",
				);
			});
		});

		describe("lintFiles()", () => {
			/** @type {InstanceType<ESLint>} */
			let eslint;

			it("should use correct parser when custom parser is specified", async () => {
				const filePath = path.resolve(
					__dirname,
					"../../fixtures/configurations/parser/custom.js",
				);

				eslint = new ESLint({
					flags,
					cwd: originalDir,
					ignore: false,
					overrideConfigFile: true,
					overrideConfig: {
						languageOptions: {
							parser: require(filePath),
						},
					},
				});

				const results = await eslint.lintFiles([filePath]);

				assert.strictEqual(results.length, 1);
				assert.strictEqual(results[0].messages.length, 1);
				assert.strictEqual(
					results[0].messages[0].message,
					"Parsing error: Boom!",
				);
				assert.strictEqual(results[0].suppressedMessages.length, 0);
			});

			it("should report zero messages when given a config file and a valid file", async () => {
				eslint = new ESLint({
					flags,
					cwd: originalDir,
					overrideConfigFile:
						"tests/fixtures/simple-valid-project/eslint.config.js",
				});
				const results = await eslint.lintFiles([
					"tests/fixtures/simple-valid-project/**/foo*.js",
				]);

				assert.strictEqual(results.length, 2);
				assert.strictEqual(results[0].messages.length, 0);
				assert.strictEqual(results[1].messages.length, 0);
				assert.strictEqual(results[0].suppressedMessages.length, 0);
			});

			it("should handle multiple patterns with overlapping files", async () => {
				eslint = new ESLint({
					flags,
					cwd: originalDir,
					overrideConfigFile:
						"tests/fixtures/simple-valid-project/eslint.config.js",
				});
				const results = await eslint.lintFiles([
					"tests/fixtures/simple-valid-project/**/foo*.js",
					"tests/fixtures/simple-valid-project/foo.?s",
					"tests/fixtures/simple-valid-project/{foo,src/foobar}.js",
				]);

				assert.strictEqual(results.length, 2);
				assert.strictEqual(results[0].messages.length, 0);
				assert.strictEqual(results[1].messages.length, 0);
				assert.strictEqual(results[0].suppressedMessages.length, 0);
			});

			it("should report zero messages when given a config file and a valid file and espree as parser", async () => {
				eslint = new ESLint({
					flags,
					overrideConfig: {
						languageOptions: {
							parser: require("espree"),
							parserOptions: {
								ecmaVersion: 2021,
							},
						},
					},
					overrideConfigFile: true,
				});
				const results = await eslint.lintFiles(["lib/cli.js"]);

				assert.strictEqual(results.length, 1);
				assert.strictEqual(results[0].messages.length, 0);
				assert.strictEqual(results[0].suppressedMessages.length, 0);
			});

			it("should report zero messages when given a config file and a valid file and esprima as parser", async () => {
				eslint = new ESLint({
					flags,
					overrideConfig: {
						languageOptions: {
							parser: require("esprima"),
						},
					},
					overrideConfigFile: true,
					ignore: false,
				});
				const results = await eslint.lintFiles([
					"tests/fixtures/passing.js",
				]);

				assert.strictEqual(results.length, 1);
				assert.strictEqual(results[0].messages.length, 0);
				assert.strictEqual(results[0].suppressedMessages.length, 0);
			});

			describe("Missing Configuration File", () => {
				const workDirName = "no-config-file";
				const workDir = path.resolve(
					fs.realpathSync(os.tmpdir()),
					"eslint/no-config",
				);

				// copy into clean area so as not to get "infected" by other config files
				before(() => {
					shell.mkdir("-p", workDir);
					shell.cp("-r", `./tests/fixtures/${workDirName}`, workDir);
				});

				after(() => {
					shell.rm("-r", workDir);
				});

				it(`${flags}:should throw if eslint.config.js file is not present`, async () => {
					eslint = new ESLint({
						flags,
						cwd: workDir,
					});
					await assert.rejects(
						() => eslint.lintFiles("no-config-file/*.js"),
						/Could not find config file/u,
					);
				});

				it("should throw if eslint.config.js file is not present even if overrideConfig was passed", async () => {
					eslint = new ESLint({
						flags,
						cwd: getFixturePath(".."),
						overrideConfig: {
							rules: {
								"no-unused-vars": 2,
							},
						},
					});
					await assert.rejects(
						() => eslint.lintFiles("no-config/no-config-file/*.js"),
						/Could not find config file/u,
					);
				});

				it("should throw if eslint.config.js file is not present even if overrideConfig was passed and a file path is given", async () => {
					eslint = new ESLint({
						flags,
						cwd: getFixturePath(".."),
						overrideConfig: {
							rules: {
								"no-unused-vars": 2,
							},
						},
					});
					await assert.rejects(
						() =>
							eslint.lintFiles("no-config/no-config-file/foo.js"),
						/Could not find config file/u,
					);
				});

				it("should not throw if eslint.config.js file is not present and overrideConfigFile is `true`", async () => {
					eslint = new ESLint({
						flags,
						cwd: workDir,
						overrideConfigFile: true,
					});
					await eslint.lintFiles("no-config-file/*.js");
				});

				it("should not throw if eslint.config.js file is not present and overrideConfigFile is path to a config file", async () => {
					eslint = new ESLint({
						flags,
						cwd: workDir,
						overrideConfigFile: path.join(
							fixtureDir,
							"configurations/quotes-error.js",
						),
					});
					await eslint.lintFiles("no-config-file/*.js");
				});
			});

			it("should throw if overrideConfigFile is path to a file that doesn't exist", async () => {
				eslint = new ESLint({
					flags,
					cwd: getFixturePath(),
					overrideConfigFile: "does-not-exist.js",
				});
				await assert.rejects(() => eslint.lintFiles("undef*.js"), {
					code: "ENOENT",
				});
			});

			it("should throw an error when given a config file and a valid file and invalid parser", async () => {
				eslint = new ESLint({
					flags,
					overrideConfig: {
						languageOptions: {
							parser: "test11",
						},
					},
					overrideConfigFile: true,
				});

				await assert.rejects(
					async () => await eslint.lintFiles(["lib/cli.js"]),
					/Expected object with parse\(\) or parseForESLint\(\) method/u,
				);
			});

			// https://github.com/eslint/eslint/issues/18407
			it("should work in case when `fsp.readFile()` returns an object that is not an instance of Promise from this realm", async () => {
				/**
				 * Promise wrapper
				 */
				class PromiseLike {
					constructor(promise) {
						this.promise = promise;
					}
					then(...args) {
						return new PromiseLike(this.promise.then(...args));
					}
					catch(...args) {
						return new PromiseLike(this.promise.catch(...args));
					}
					finally(...args) {
						return new PromiseLike(this.promise.finally(...args));
					}
				}

				const spy = sinon.spy(
					(...args) => new PromiseLike(fsp.readFile(...args)),
				);

				const { ESLint: LocalESLint } = proxyquire(
					"../../../lib/eslint/eslint",
					{
						"node:fs/promises": {
							readFile: spy,
							"@noCallThru": false, // allows calling other methods of `fs/promises`
						},
					},
				);

				const testDir = "tests/fixtures/simple-valid-project";
				const expectedLintedFiles = [
					path.resolve(testDir, "foo.js"),
					path.resolve(testDir, "src", "foobar.js"),
				];

				eslint = new LocalESLint({
					flags,
					cwd: originalDir,
					overrideConfigFile: path.resolve(
						testDir,
						"eslint.config.js",
					),
				});

				const results = await eslint.lintFiles([
					`${testDir}/**/foo*.js`,
				]);

				assert.strictEqual(results.length, expectedLintedFiles.length);

				expectedLintedFiles.forEach((file, index) => {
					assert(
						spy.calledWith(file),
						`Spy was not called with ${file}`,
					);
					assert.strictEqual(results[index].filePath, file);
					assert.strictEqual(results[index].messages.length, 0);
					assert.strictEqual(
						results[index].suppressedMessages.length,
						0,
					);
				});
			});

			describe("Overlapping searches", () => {
				it("should not lint the same file multiple times when the file path was passed multiple times", async () => {
					const cwd = getFixturePath();

					eslint = new ESLint({
						flags,
						cwd,
						overrideConfigFile: true,
					});

					const results = await eslint.lintFiles([
						"files/foo.js",
						"files/../files/foo.js",
						"files/foo.js",
					]);

					assert.strictEqual(results.length, 1);
					assert.strictEqual(
						results[0].filePath,
						path.resolve(cwd, "files/foo.js"),
					);
					assert.strictEqual(results[0].messages.length, 0);
					assert.strictEqual(results[0].suppressedMessages.length, 0);
				});

				it("should not lint the same file multiple times when the file path and a pattern that matches the file were passed", async () => {
					const cwd = getFixturePath();

					eslint = new ESLint({
						flags,
						cwd,
						overrideConfigFile: true,
					});

					const results = await eslint.lintFiles([
						"files/foo.js",
						"files/foo*",
					]);

					assert.strictEqual(results.length, 1);
					assert.strictEqual(
						results[0].filePath,
						path.resolve(cwd, "files/foo.js"),
					);
					assert.strictEqual(results[0].messages.length, 0);
					assert.strictEqual(results[0].suppressedMessages.length, 0);
				});

				it("should not lint the same file multiple times when multiple patterns that match the file were passed", async () => {
					const cwd = getFixturePath();

					eslint = new ESLint({
						flags,
						cwd,
						overrideConfigFile: true,
					});

					const results = await eslint.lintFiles([
						"files/f*.js",
						"files/foo*",
					]);

					assert.strictEqual(results.length, 1);
					assert.strictEqual(
						results[0].filePath,
						path.resolve(cwd, "files/foo.js"),
					);
					assert.strictEqual(results[0].messages.length, 0);
					assert.strictEqual(results[0].suppressedMessages.length, 0);
				});
			});

			describe("Invalid inputs", () => {
				[
					["a string with a single space", " "],
					["an array with one empty string", [""]],
					["an array with two empty strings", ["", ""]],
					["undefined", void 0],
				].forEach(([name, value]) => {
					it(`should throw an error when passed ${name}`, async () => {
						eslint = new ESLint({
							flags,
							overrideConfigFile: true,
						});

						await assert.rejects(
							async () => await eslint.lintFiles(value),
							/'patterns' must be a non-empty string or an array of non-empty strings/u,
						);
					});
				});
			});

			describe("Normalized inputs", () => {
				[
					["an empty string", ""],
					["an empty array", []],
				].forEach(([name, value]) => {
					it(`should normalize to '.' when ${name} is passed`, async () => {
						eslint = new ESLint({
							flags,
							ignore: false,
							cwd: getFixturePath("files"),
							overrideConfig: { files: ["**/*.js"] },
							overrideConfigFile:
								getFixturePath("eslint.config.js"),
						});
						const results = await eslint.lintFiles(value);

						assert.strictEqual(results.length, 2);
						assert.strictEqual(
							results[0].filePath,
							getFixturePath("files/.bar.js"),
						);
						assert.strictEqual(results[0].messages.length, 0);
						assert.strictEqual(
							results[1].filePath,
							getFixturePath("files/foo.js"),
						);
						assert.strictEqual(results[1].messages.length, 0);
						assert.strictEqual(
							results[0].suppressedMessages.length,
							0,
						);
					});

					it(`should return an empty array when ${name} is passed with passOnNoPatterns: true`, async () => {
						eslint = new ESLint({
							flags,
							ignore: false,
							cwd: getFixturePath("files"),
							overrideConfig: { files: ["**/*.js"] },
							overrideConfigFile:
								getFixturePath("eslint.config.js"),
							passOnNoPatterns: true,
						});
						const results = await eslint.lintFiles(value);

						assert.strictEqual(results.length, 0);
					});
				});
			});

			it("should report zero messages when given a directory with a .js2 file", async () => {
				eslint = new ESLint({
					flags,
					cwd: path.join(fixtureDir, ".."),
					overrideConfigFile: getFixturePath("eslint.config.js"),
					overrideConfig: {
						files: ["**/*.js2"],
					},
				});
				const results = await eslint.lintFiles([
					getFixturePath("files/foo.js2"),
				]);

				assert.strictEqual(results.length, 1);
				assert.strictEqual(results[0].messages.length, 0);
				assert.strictEqual(results[0].suppressedMessages.length, 0);
			});

			it("should report zero messages when given a directory with a .js and a .js2 file", async () => {
				eslint = new ESLint({
					flags,
					ignore: false,
					cwd: getFixturePath(".."),
					overrideConfig: { files: ["**/*.js", "**/*.js2"] },
					overrideConfigFile: getFixturePath("eslint.config.js"),
				});
				const results = await eslint.lintFiles(["fixtures/files/"]);

				assert.strictEqual(results.length, 3);
				assert.strictEqual(results[0].messages.length, 0);
				assert.strictEqual(results[1].messages.length, 0);
				assert.strictEqual(results[0].suppressedMessages.length, 0);
			});

			// https://github.com/eslint/eslint/issues/18550
			it("should skip files with non-standard extensions when they're matched only by a '*' files pattern", async () => {
				eslint = new ESLint({
					flags,
					cwd: getFixturePath("files"),
					overrideConfig: { files: ["*"] },
					overrideConfigFile: true,
				});
				const results = await eslint.lintFiles(["."]);

				assert.strictEqual(results.length, 2);
				assert(
					results.every(result =>
						/^\.[cm]?js$/u.test(path.extname(result.filePath)),
					),
					"File with a non-standard extension was linted",
				);
			});

			// https://github.com/eslint/eslint/issues/16413
			it("should find files and report zero messages when given a parent directory with a .js", async () => {
				eslint = new ESLint({
					flags,
					ignore: false,
					cwd: getFixturePath("example-app/subdir"),
				});
				const results = await eslint.lintFiles(["../*.js"]);

				assert.strictEqual(results.length, 2);
				assert.strictEqual(results[0].messages.length, 0);
				assert.strictEqual(results[0].suppressedMessages.length, 0);
				assert.strictEqual(results[1].messages.length, 0);
				assert.strictEqual(results[1].suppressedMessages.length, 0);
			});

			// https://github.com/eslint/eslint/issues/16038
			it("should allow files patterns with '..' inside", async () => {
				eslint = new ESLint({
					flags,
					ignore: false,
					cwd: getFixturePath("dots-in-files"),
				});
				const results = await eslint.lintFiles(["."]);

				assert.strictEqual(results.length, 2);
				assert.strictEqual(results[0].messages.length, 0);
				assert.strictEqual(
					results[0].filePath,
					getFixturePath("dots-in-files/a..b.js"),
				);
				assert.strictEqual(results[0].suppressedMessages.length, 0);
			});

			// https://github.com/eslint/eslint/issues/16299
			it("should only find files in the subdir1 directory when given a directory name", async () => {
				eslint = new ESLint({
					flags,
					ignore: false,
					cwd: getFixturePath("example-app2"),
				});
				const results = await eslint.lintFiles(["subdir1"]);

				assert.strictEqual(results.length, 1);
				assert.strictEqual(results[0].messages.length, 0);
				assert.strictEqual(
					results[0].filePath,
					getFixturePath("example-app2/subdir1/a.js"),
				);
				assert.strictEqual(results[0].suppressedMessages.length, 0);
			});

			// https://github.com/eslint/eslint/issues/14742
			it("should run", async () => {
				eslint = new ESLint({
					flags,
					cwd: getFixturePath("{curly-path}", "server"),
				});
				const results = await eslint.lintFiles(["src/**/*.{js,json}"]);

				assert.strictEqual(results.length, 1);
				assert.strictEqual(results[0].messages.length, 1);
				assert.strictEqual(results[0].messages[0].ruleId, "no-console");
				assert.strictEqual(
					results[0].filePath,
					getFixturePath("{curly-path}/server/src/two.js"),
				);
				assert.strictEqual(results[0].suppressedMessages.length, 0);
			});

			it("should work with config file that exports a promise", async () => {
				eslint = new ESLint({
					flags,
					cwd: getFixturePath("promise-config"),
				});
				const results = await eslint.lintFiles(["a*.js"]);

				assert.strictEqual(results.length, 1);
				assert.strictEqual(
					results[0].filePath,
					getFixturePath("promise-config", "a.js"),
				);
				assert.strictEqual(results[0].messages.length, 1);
				assert.strictEqual(results[0].messages[0].severity, 2);
				assert.strictEqual(results[0].messages[0].ruleId, "quotes");
			});

			// https://github.com/eslint/eslint/issues/16265
			describe("Dot files in searches", () => {
				it("should find dot files in current directory when a . pattern is used", async () => {
					eslint = new ESLint({
						flags,
						cwd: getFixturePath("dot-files"),
					});
					const results = await eslint.lintFiles(["."]);

					assert.strictEqual(results.length, 3);
					assert.strictEqual(results[0].messages.length, 0);
					assert.strictEqual(
						results[0].filePath,
						getFixturePath("dot-files/.a.js"),
					);
					assert.strictEqual(results[0].suppressedMessages.length, 0);
					assert.strictEqual(results[1].messages.length, 0);
					assert.strictEqual(
						results[1].filePath,
						getFixturePath("dot-files/.c.js"),
					);
					assert.strictEqual(results[1].suppressedMessages.length, 0);
					assert.strictEqual(results[2].messages.length, 0);
					assert.strictEqual(
						results[2].filePath,
						getFixturePath("dot-files/b.js"),
					);
					assert.strictEqual(results[2].suppressedMessages.length, 0);
				});

				it("should find dot files in current directory when a *.js pattern is used", async () => {
					eslint = new ESLint({
						flags,
						cwd: getFixturePath("dot-files"),
					});
					const results = await eslint.lintFiles(["*.js"]);

					assert.strictEqual(results.length, 3);
					assert.strictEqual(results[0].messages.length, 0);
					assert.strictEqual(
						results[0].filePath,
						getFixturePath("dot-files/.a.js"),
					);
					assert.strictEqual(results[0].suppressedMessages.length, 0);
					assert.strictEqual(results[1].messages.length, 0);
					assert.strictEqual(
						results[1].filePath,
						getFixturePath("dot-files/.c.js"),
					);
					assert.strictEqual(results[1].suppressedMessages.length, 0);
					assert.strictEqual(results[2].messages.length, 0);
					assert.strictEqual(
						results[2].filePath,
						getFixturePath("dot-files/b.js"),
					);
					assert.strictEqual(results[2].suppressedMessages.length, 0);
				});

				it("should find dot files in current directory when a .a.js pattern is used", async () => {
					eslint = new ESLint({
						flags,
						cwd: getFixturePath("dot-files"),
					});
					const results = await eslint.lintFiles([".a.js"]);

					assert.strictEqual(results.length, 1);
					assert.strictEqual(results[0].messages.length, 0);
					assert.strictEqual(
						results[0].filePath,
						getFixturePath("dot-files/.a.js"),
					);
					assert.strictEqual(results[0].suppressedMessages.length, 0);
				});
			});

			// https://github.com/eslint/eslint/issues/16275
			describe("Glob patterns without matches", () => {
				it("should throw an error for a missing pattern when combined with a found pattern", async () => {
					eslint = new ESLint({
						flags,
						ignore: false,
						cwd: getFixturePath("example-app2"),
					});

					await assert.rejects(async () => {
						await eslint.lintFiles([
							"subdir1",
							"doesnotexist/*.js",
						]);
					}, /No files matching 'doesnotexist\/\*\.js' were found/u);
				});

				it("should throw an error for an ignored directory pattern when combined with a found pattern", async () => {
					eslint = new ESLint({
						flags,
						cwd: getFixturePath("example-app2"),
						overrideConfig: {
							ignores: ["subdir2"],
						},
					});

					await assert.rejects(async () => {
						await eslint.lintFiles([
							"subdir1/*.js",
							"subdir2/*.js",
						]);
					}, /All files matched by 'subdir2\/\*\.js' are ignored/u);
				});

				it("should throw an error for an ignored file pattern when combined with a found pattern", async () => {
					eslint = new ESLint({
						flags,
						cwd: getFixturePath("example-app2"),
						overrideConfig: {
							ignores: ["subdir2/*.js"],
						},
					});

					await assert.rejects(async () => {
						await eslint.lintFiles([
							"subdir1/*.js",
							"subdir2/*.js",
						]);
					}, /All files matched by 'subdir2\/\*\.js' are ignored/u);
				});

				it("should always throw an error for the first unmatched file pattern", async () => {
					eslint = new ESLint({
						flags,
						cwd: getFixturePath("example-app2"),
						overrideConfig: {
							ignores: ["subdir1/*.js", "subdir2/*.js"],
						},
					});

					await assert.rejects(async () => {
						await eslint.lintFiles([
							"doesnotexist1/*.js",
							"doesnotexist2/*.js",
						]);
					}, /No files matching 'doesnotexist1\/\*\.js' were found/u);

					await assert.rejects(async () => {
						await eslint.lintFiles([
							"doesnotexist1/*.js",
							"subdir1/*.js",
						]);
					}, /No files matching 'doesnotexist1\/\*\.js' were found/u);

					await assert.rejects(async () => {
						await eslint.lintFiles([
							"subdir1/*.js",
							"doesnotexist1/*.js",
						]);
					}, /All files matched by 'subdir1\/\*\.js' are ignored/u);

					await assert.rejects(async () => {
						await eslint.lintFiles([
							"subdir1/*.js",
							"subdir2/*.js",
						]);
					}, /All files matched by 'subdir1\/\*\.js' are ignored/u);
				});

				it("should not throw an error for an ignored file pattern when errorOnUnmatchedPattern is false", async () => {
					eslint = new ESLint({
						flags,
						cwd: getFixturePath("example-app2"),
						overrideConfig: {
							ignores: ["subdir2/*.js"],
						},
						errorOnUnmatchedPattern: false,
					});

					const results = await eslint.lintFiles(["subdir2/*.js"]);

					assert.strictEqual(results.length, 0);
				});

				it("should not throw an error for a non-existing file pattern when errorOnUnmatchedPattern is false", async () => {
					eslint = new ESLint({
						flags,
						cwd: getFixturePath("example-app2"),
						errorOnUnmatchedPattern: false,
					});

					const results = await eslint.lintFiles(["doesexist/*.js"]);

					assert.strictEqual(results.length, 0);
				});
			});

			// https://github.com/eslint/eslint/issues/16260
			describe("Globbing based on configs", () => {
				it("should report zero messages when given a directory with a .js and config file specifying a subdirectory", async () => {
					eslint = new ESLint({
						flags,
						ignore: false,
						cwd: getFixturePath("shallow-glob"),
					});
					const results = await eslint.lintFiles(["target-dir"]);

					assert.strictEqual(results.length, 1);
					assert.strictEqual(results[0].messages.length, 0);
					assert.strictEqual(results[0].suppressedMessages.length, 0);
				});

				it("should glob for .jsx file in a subdirectory of the passed-in directory and not glob for any other patterns", async () => {
					eslint = new ESLint({
						flags,
						ignore: false,
						overrideConfigFile: true,
						overrideConfig: {
							files: ["subdir/**/*.jsx", "target-dir/*.js"],
							languageOptions: {
								parserOptions: {
									jsx: true,
								},
							},
						},
						cwd: getFixturePath("shallow-glob"),
					});
					const results = await eslint.lintFiles([
						"subdir/subsubdir",
					]);

					assert.strictEqual(results.length, 2);
					assert.strictEqual(results[0].messages.length, 1);
					assert.strictEqual(
						results[0].filePath,
						getFixturePath(
							"shallow-glob/subdir/subsubdir/broken.js",
						),
					);
					assert(
						results[0].messages[0].fatal,
						"Fatal error expected.",
					);
					assert.strictEqual(results[0].suppressedMessages.length, 0);
					assert.strictEqual(
						results[1].filePath,
						getFixturePath(
							"shallow-glob/subdir/subsubdir/plain.jsx",
						),
					);
					assert.strictEqual(results[1].messages.length, 0);
					assert.strictEqual(results[1].suppressedMessages.length, 0);
				});

				it("should glob for all files in subdir when passed-in on the command line with a partial matching glob", async () => {
					eslint = new ESLint({
						flags,
						ignore: false,
						overrideConfigFile: true,
						overrideConfig: {
							files: ["s*/subsubdir/*.jsx", "target-dir/*.js"],
							languageOptions: {
								parserOptions: {
									jsx: true,
								},
							},
						},
						cwd: getFixturePath("shallow-glob"),
					});
					const results = await eslint.lintFiles(["subdir"]);

					assert.strictEqual(results.length, 3);
					assert.strictEqual(results[0].messages.length, 1);
					assert(
						results[0].messages[0].fatal,
						"Fatal error expected.",
					);
					assert.strictEqual(results[0].suppressedMessages.length, 0);
					assert.strictEqual(results[1].messages.length, 1);
					assert(
						results[0].messages[0].fatal,
						"Fatal error expected.",
					);
					assert.strictEqual(results[1].suppressedMessages.length, 0);
					assert.strictEqual(results[2].messages.length, 0);
					assert.strictEqual(results[2].suppressedMessages.length, 0);
				});
			});

			describe("Globbing based on configs with negated patterns and arrays in `files`", () => {
				// https://github.com/eslint/eslint/issues/19813
				it("should not include custom extensions when negated pattern is specified in `files`", async () => {
					eslint = new ESLint({
						flags,
						cwd: getFixturePath("file-extensions"),
						overrideConfigFile: true,
						overrideConfig: [
							{
								files: ["!foo.js"],
							},
							{
								files: ["!foo.jsx"],
							},
							{
								files: ["!foo.ts"],
							},
							{
								files: ["!g.tsx"],
							},
						],
					});
					const results = await eslint.lintFiles(["."]);

					// should not include d.jsx, f.ts, and other extensions that are not linted by default
					assert.strictEqual(results.length, 4);
					assert.deepStrictEqual(
						results.map(({ filePath }) => path.basename(filePath)),
						["a.js", "b.mjs", "c.cjs", "eslint.config.js"],
					);
				});

				it("should not include custom extensions when negated pattern is specified in an array in `files`", async () => {
					eslint = new ESLint({
						flags,
						cwd: getFixturePath("file-extensions"),
						overrideConfigFile: true,
						overrideConfig: [
							{
								files: [["*", "!foo.js"]],
							},
							{
								files: [["!foo.js", "*"]],
							},
							{
								files: [["*", "!foo.ts"]],
							},
							{
								files: [["!foo.ts", "*"]],
							},
							{
								files: [["*", "!g.tsx"]],
							},
							{
								files: [["!g.tsx", "*"]],
							},
						],
					});
					const results = await eslint.lintFiles(["."]);

					// should not include d.jsx, f.ts, and other extensions that are not linted by default
					assert.strictEqual(results.length, 4);
					assert.deepStrictEqual(
						results.map(({ filePath }) => path.basename(filePath)),
						["a.js", "b.mjs", "c.cjs", "eslint.config.js"],
					);
				});

				// https://github.com/eslint/eslint/issues/19814
				it("should include custom extensions when matched by a non-universal pattern specified in an array in `files`", async () => {
					eslint = new ESLint({
						flags,
						cwd: getFixturePath("file-extensions", ".."),
						overrideConfigFile: true,
						overrideConfig: [
							{
								files: [["**/*.jsx", "file-extensions/*"]],
							},
							{
								files: [["file-extensions/*", "**/*.ts"]],
							},
						],
					});
					const results = await eslint.lintFiles(["file-extensions"]);

					// should include d.jsx and f.ts, but not other extensions that are not linted by default
					assert.strictEqual(results.length, 6);
					assert.deepStrictEqual(
						results.map(({ filePath }) => path.basename(filePath)),
						[
							"a.js",
							"b.mjs",
							"c.cjs",
							"d.jsx",
							"eslint.config.js",
							"f.ts",
						],
					);
				});
			});

			it("should report zero messages when given a '**' pattern with a .js and a .js2 file", async () => {
				eslint = new ESLint({
					flags,
					ignore: false,
					cwd: path.join(fixtureDir, ".."),
					overrideConfig: { files: ["**/*.js", "**/*.js2"] },
					overrideConfigFile: getFixturePath("eslint.config.js"),
				});
				const results = await eslint.lintFiles(["fixtures/files/*"]);

				assert.strictEqual(results.length, 3);
				assert.strictEqual(results[0].messages.length, 0);
				assert.strictEqual(results[1].messages.length, 0);
				assert.strictEqual(results[2].messages.length, 0);
				assert.strictEqual(results[0].suppressedMessages.length, 0);
				assert.strictEqual(results[1].suppressedMessages.length, 0);
				assert.strictEqual(results[2].suppressedMessages.length, 0);
			});

			it("should resolve globs when 'globInputPaths' option is true", async () => {
				eslint = new ESLint({
					flags,
					ignore: false,
					cwd: getFixturePath(".."),
					overrideConfig: { files: ["**/*.js", "**/*.js2"] },
					overrideConfigFile: getFixturePath("eslint.config.js"),
				});
				const results = await eslint.lintFiles(["fixtures/files/*"]);

				assert.strictEqual(results.length, 3);
				assert.strictEqual(results[0].messages.length, 0);
				assert.strictEqual(results[1].messages.length, 0);
				assert.strictEqual(results[2].messages.length, 0);
				assert.strictEqual(results[0].suppressedMessages.length, 0);
				assert.strictEqual(results[1].suppressedMessages.length, 0);
				assert.strictEqual(results[2].suppressedMessages.length, 0);
			});

			// only works on a Windows machine
			if (os.platform() === "win32") {
				it("should resolve globs with Windows slashes when 'globInputPaths' option is true", async () => {
					eslint = new ESLint({
						flags,
						ignore: false,
						cwd: getFixturePath(".."),
						overrideConfig: { files: ["**/*.js", "**/*.js2"] },
						overrideConfigFile: getFixturePath("eslint.config.js"),
					});
					const results = await eslint.lintFiles([
						"fixtures\\files\\*",
					]);

					assert.strictEqual(results.length, 3);
					assert.strictEqual(results[0].messages.length, 0);
					assert.strictEqual(results[1].messages.length, 0);
					assert.strictEqual(results[2].messages.length, 0);
					assert.strictEqual(results[0].suppressedMessages.length, 0);
					assert.strictEqual(results[1].suppressedMessages.length, 0);
					assert.strictEqual(results[2].suppressedMessages.length, 0);
				});
			}

			it("should not resolve globs when 'globInputPaths' option is false", async () => {
				eslint = new ESLint({
					flags,
					ignore: false,
					cwd: getFixturePath(".."),
					overrideConfig: { files: ["**/*.js", "**/*.js2"] },
					overrideConfigFile: true,
					globInputPaths: false,
				});

				await assert.rejects(async () => {
					await eslint.lintFiles(["fixtures/files/*"]);
				}, /No files matching 'fixtures\/files\/\*' were found \(glob was disabled\)\./u);
			});

			describe("Ignoring Files", () => {
				it("should report on a file in the node_modules folder passed explicitly, even if ignored by default", async () => {
					eslint = new ESLint({
						flags,
						cwd: getFixturePath("cli-engine"),
					});
					const results = await eslint.lintFiles([
						"node_modules/foo.js",
					]);
					const expectedMsg =
						'File ignored by default because it is located under the node_modules directory. Use ignore pattern "!**/node_modules/" to disable file ignore settings or use "--no-warn-ignored" to suppress this warning.';

					assert.strictEqual(results.length, 1);
					assert.strictEqual(results[0].errorCount, 0);
					assert.strictEqual(results[0].warningCount, 1);
					assert.strictEqual(results[0].fatalErrorCount, 0);
					assert.strictEqual(results[0].fixableErrorCount, 0);
					assert.strictEqual(results[0].fixableWarningCount, 0);
					assert.strictEqual(results[0].messages[0].severity, 1);
					assert.strictEqual(
						results[0].messages[0].message,
						expectedMsg,
					);
					assert.strictEqual(results[0].suppressedMessages.length, 0);
				});

				it("should report on a file in a node_modules subfolder passed explicitly, even if ignored by default", async () => {
					eslint = new ESLint({
						flags,
						cwd: getFixturePath("cli-engine"),
					});
					const results = await eslint.lintFiles([
						"nested_node_modules/subdir/node_modules/text.js",
					]);
					const expectedMsg =
						'File ignored by default because it is located under the node_modules directory. Use ignore pattern "!**/node_modules/" to disable file ignore settings or use "--no-warn-ignored" to suppress this warning.';

					assert.strictEqual(results.length, 1);
					assert.strictEqual(results[0].errorCount, 0);
					assert.strictEqual(results[0].warningCount, 1);
					assert.strictEqual(results[0].fatalErrorCount, 0);
					assert.strictEqual(results[0].fixableErrorCount, 0);
					assert.strictEqual(results[0].fixableWarningCount, 0);
					assert.strictEqual(results[0].messages[0].severity, 1);
					assert.strictEqual(
						results[0].messages[0].message,
						expectedMsg,
					);
					assert.strictEqual(results[0].suppressedMessages.length, 0);
				});

				it('should report on an ignored file with "node_modules" in its name', async () => {
					eslint = new ESLint({
						flags,
						cwd: getFixturePath("cli-engine"),
						ignorePatterns: ["*.js"],
					});
					const results = await eslint.lintFiles([
						"node_modules_cleaner.js",
					]);
					const expectedMsg =
						'File ignored because of a matching ignore pattern. Use "--no-ignore" to disable file ignore settings or use "--no-warn-ignored" to suppress this warning.';

					assert.strictEqual(results.length, 1);
					assert.strictEqual(results[0].errorCount, 0);
					assert.strictEqual(results[0].warningCount, 1);
					assert.strictEqual(results[0].fatalErrorCount, 0);
					assert.strictEqual(results[0].fixableErrorCount, 0);
					assert.strictEqual(results[0].fixableWarningCount, 0);
					assert.strictEqual(results[0].messages[0].severity, 1);
					assert.strictEqual(
						results[0].messages[0].message,
						expectedMsg,
					);
					assert.strictEqual(results[0].suppressedMessages.length, 0);
				});

				it("should suppress the warning when a file in the node_modules folder passed explicitly and warnIgnored is false", async () => {
					eslint = new ESLint({
						flags,
						cwd: getFixturePath("cli-engine"),
						warnIgnored: false,
					});
					const results = await eslint.lintFiles([
						"node_modules/foo.js",
					]);

					assert.strictEqual(results.length, 0);
				});

				it("should report on globs with explicit inclusion of dotfiles", async () => {
					eslint = new ESLint({
						flags,
						cwd: getFixturePath("cli-engine"),
						overrideConfigFile: true,
						overrideConfig: {
							rules: {
								quotes: [2, "single"],
							},
						},
					});
					const results = await eslint.lintFiles([
						"hidden/.hiddenfolder/*.js",
					]);

					assert.strictEqual(results.length, 1);
					assert.strictEqual(results[0].errorCount, 1);
					assert.strictEqual(results[0].warningCount, 0);
					assert.strictEqual(results[0].fatalErrorCount, 0);
					assert.strictEqual(results[0].fixableErrorCount, 1);
					assert.strictEqual(results[0].fixableWarningCount, 0);
				});

				it("should ignore node_modules files when using ignore file", async () => {
					eslint = new ESLint({
						flags,
						cwd: getFixturePath("cli-engine"),
						overrideConfigFile: true,
					});

					await assert.rejects(async () => {
						await eslint.lintFiles(["node_modules"]);
					}, /All files matched by 'node_modules' are ignored\./u);
				});

				// https://github.com/eslint/eslint/issues/5547
				it("should ignore node_modules files even with ignore: false", async () => {
					eslint = new ESLint({
						flags,
						cwd: getFixturePath("cli-engine"),
						ignore: false,
					});

					await assert.rejects(async () => {
						await eslint.lintFiles(["node_modules"]);
					}, /All files matched by 'node_modules' are ignored\./u);
				});

				it("should throw an error when all given files are ignored", async () => {
					eslint = new ESLint({
						flags,
						overrideConfigFile: getFixturePath(
							"eslint.config-with-ignores.js",
						),
					});

					await assert.rejects(async () => {
						await eslint.lintFiles(["tests/fixtures/cli-engine/"]);
					}, /All files matched by 'tests\/fixtures\/cli-engine\/' are ignored\./u);
				});

				it("should throw an error when all given files are ignored by a config object that has `name`", async () => {
					eslint = new ESLint({
						flags,
						overrideConfigFile: getFixturePath(
							"eslint.config-with-ignores3.js",
						),
					});

					await assert.rejects(async () => {
						await eslint.lintFiles(["tests/fixtures/cli-engine/"]);
					}, /All files matched by 'tests\/fixtures\/cli-engine\/' are ignored\./u);
				});

				it("should throw an error when all given files are ignored even with a `./` prefix", async () => {
					eslint = new ESLint({
						flags,
						overrideConfigFile: getFixturePath(
							"eslint.config-with-ignores.js",
						),
					});

					await assert.rejects(async () => {
						await eslint.lintFiles([
							"./tests/fixtures/cli-engine/",
						]);
					}, /All files matched by '\.\/tests\/fixtures\/cli-engine\/' are ignored\./u);
				});

				// https://github.com/eslint/eslint/issues/3788
				it("should ignore one-level down node_modules by default", async () => {
					eslint = new ESLint({
						flags,
						overrideConfigFile: true,
						overrideConfig: {
							rules: {
								quotes: [2, "double"],
							},
						},
						cwd: getFixturePath(
							"cli-engine",
							"nested_node_modules",
						),
					});
					const results = await eslint.lintFiles(["."]);

					assert.strictEqual(results.length, 1);
					assert.strictEqual(results[0].errorCount, 0);
					assert.strictEqual(results[0].warningCount, 0);
					assert.strictEqual(results[0].fatalErrorCount, 0);
					assert.strictEqual(results[0].fixableErrorCount, 0);
					assert.strictEqual(results[0].fixableWarningCount, 0);
				});

				// https://github.com/eslint/eslint/issues/3812
				it("should ignore all files and throw an error when **/fixtures/** is in `ignores` in the config file", async () => {
					eslint = new ESLint({
						flags,
						overrideConfigFile: getFixturePath(
							"cli-engine/eslint.config-with-ignores2.js",
						),
						overrideConfig: {
							rules: {
								quotes: [2, "double"],
							},
						},
					});

					await assert.rejects(async () => {
						await eslint.lintFiles([
							"./tests/fixtures/cli-engine/",
						]);
					}, /All files matched by '\.\/tests\/fixtures\/cli-engine\/' are ignored\./u);
				});

				it("should throw an error when all given files are ignored via ignorePatterns", async () => {
					eslint = new ESLint({
						flags,
						overrideConfigFile: true,
						ignorePatterns: ["tests/fixtures/single-quoted.js"],
					});

					await assert.rejects(async () => {
						await eslint.lintFiles(["tests/fixtures/*-quoted.js"]);
					}, /All files matched by 'tests\/fixtures\/\*-quoted\.js' are ignored\./u);
				});

				it("should not throw an error when ignorePatterns is an empty array", async () => {
					eslint = new ESLint({
						flags,
						overrideConfigFile: true,
						ignorePatterns: [],
					});

					await assert.doesNotReject(async () => {
						await eslint.lintFiles(["*.js"]);
					});
				});

				it("should return a warning when an explicitly given file is ignored", async () => {
					eslint = new ESLint({
						flags,
						overrideConfigFile: "eslint.config-with-ignores.js",
						cwd: getFixturePath(),
					});
					const filePath = getFixturePath("passing.js");
					const results = await eslint.lintFiles([filePath]);

					assert.strictEqual(results.length, 1);
					assert.strictEqual(results[0].filePath, filePath);
					assert.strictEqual(results[0].messages[0].severity, 1);
					assert.strictEqual(
						results[0].messages[0].message,
						'File ignored because of a matching ignore pattern. Use "--no-ignore" to disable file ignore settings or use "--no-warn-ignored" to suppress this warning.',
					);
					assert.strictEqual(results[0].errorCount, 0);
					assert.strictEqual(results[0].warningCount, 1);
					assert.strictEqual(results[0].fatalErrorCount, 0);
					assert.strictEqual(results[0].fixableErrorCount, 0);
					assert.strictEqual(results[0].fixableWarningCount, 0);
					assert.strictEqual(results[0].suppressedMessages.length, 0);
				});

				it("should return a warning when an explicitly given file has no matching config", async () => {
					eslint = new ESLint({
						flags,
						overrideConfigFile: true,
						cwd: getFixturePath(),
					});
					const filePath = getFixturePath("files", "foo.js2");
					const results = await eslint.lintFiles([filePath]);

					assert.strictEqual(results.length, 1);
					assert.strictEqual(results[0].filePath, filePath);
					assert.strictEqual(results[0].messages[0].severity, 1);
					assert.strictEqual(
						results[0].messages[0].message,
						"File ignored because no matching configuration was supplied.",
					);
					assert.strictEqual(results[0].errorCount, 0);
					assert.strictEqual(results[0].warningCount, 1);
					assert.strictEqual(results[0].fatalErrorCount, 0);
					assert.strictEqual(results[0].fixableErrorCount, 0);
					assert.strictEqual(results[0].fixableWarningCount, 0);
					assert.strictEqual(results[0].suppressedMessages.length, 0);
				});

				it("should return a warning when an explicitly given file is outside the base path", async () => {
					eslint = new ESLint({
						flags,
						overrideConfigFile: true,
						cwd: getFixturePath("files"),
					});
					const filePath = getFixturePath("passing.js");
					const results = await eslint.lintFiles([filePath]);

					assert.strictEqual(results.length, 1);
					assert.strictEqual(results[0].filePath, filePath);
					assert.strictEqual(results[0].messages[0].severity, 1);
					assert.strictEqual(
						results[0].messages[0].message,
						"File ignored because outside of base path.",
					);
					assert.strictEqual(results[0].errorCount, 0);
					assert.strictEqual(results[0].warningCount, 1);
					assert.strictEqual(results[0].fatalErrorCount, 0);
					assert.strictEqual(results[0].fixableErrorCount, 0);
					assert.strictEqual(results[0].fixableWarningCount, 0);
					assert.strictEqual(results[0].suppressedMessages.length, 0);
				});

				it("should suppress the warning when an explicitly given file is ignored and warnIgnored is false", async () => {
					eslint = new ESLint({
						flags,
						overrideConfigFile: "eslint.config-with-ignores.js",
						cwd: getFixturePath(),
						warnIgnored: false,
					});
					const filePath = getFixturePath("passing.js");
					const results = await eslint.lintFiles([filePath]);

					assert.strictEqual(results.length, 0);
				});

				it("should return a warning about matching ignore patterns when an explicitly given dotfile is ignored", async () => {
					eslint = new ESLint({
						flags,
						overrideConfigFile: "eslint.config-with-ignores.js",
						cwd: getFixturePath(),
					});
					const filePath = getFixturePath("dot-files/.a.js");
					const results = await eslint.lintFiles([filePath]);

					assert.strictEqual(results.length, 1);
					assert.strictEqual(results[0].filePath, filePath);
					assert.strictEqual(results[0].messages[0].severity, 1);
					assert.strictEqual(
						results[0].messages[0].message,
						'File ignored because of a matching ignore pattern. Use "--no-ignore" to disable file ignore settings or use "--no-warn-ignored" to suppress this warning.',
					);
					assert.strictEqual(results[0].errorCount, 0);
					assert.strictEqual(results[0].warningCount, 1);
					assert.strictEqual(results[0].fatalErrorCount, 0);
					assert.strictEqual(results[0].fixableErrorCount, 0);
					assert.strictEqual(results[0].fixableWarningCount, 0);
					assert.strictEqual(results[0].suppressedMessages.length, 0);
				});

				it("should return two messages when given a file in excluded files list while ignore is off", async () => {
					eslint = new ESLint({
						flags,
						cwd: getFixturePath(),
						ignore: false,
						overrideConfigFile: getFixturePath(
							"eslint.config-with-ignores.js",
						),
						overrideConfig: {
							rules: {
								"no-undef": 2,
							},
						},
					});
					const filePath = fs.realpathSync(
						getFixturePath("undef.js"),
					);
					const results = await eslint.lintFiles([filePath]);

					assert.strictEqual(results.length, 1);
					assert.strictEqual(results[0].filePath, filePath);
					assert.strictEqual(
						results[0].messages[0].ruleId,
						"no-undef",
					);
					assert.strictEqual(results[0].messages[0].severity, 2);
					assert.strictEqual(
						results[0].messages[1].ruleId,
						"no-undef",
					);
					assert.strictEqual(results[0].messages[1].severity, 2);
					assert.strictEqual(results[0].suppressedMessages.length, 0);
				});

				it("should return two messages when given a file in excluded files list by a config object that has `name` while ignore is off", async () => {
					eslint = new ESLint({
						flags,
						cwd: getFixturePath(),
						ignore: false,
						overrideConfigFile: getFixturePath(
							"eslint.config-with-ignores3.js",
						),
						overrideConfig: {
							rules: {
								"no-undef": 2,
							},
						},
					});
					const filePath = fs.realpathSync(
						getFixturePath("undef.js"),
					);
					const results = await eslint.lintFiles([filePath]);

					assert.strictEqual(results.length, 1);
					assert.strictEqual(results[0].filePath, filePath);
					assert.strictEqual(
						results[0].messages[0].ruleId,
						"no-undef",
					);
					assert.strictEqual(results[0].messages[0].severity, 2);
					assert.strictEqual(
						results[0].messages[1].ruleId,
						"no-undef",
					);
					assert.strictEqual(results[0].messages[1].severity, 2);
					assert.strictEqual(results[0].suppressedMessages.length, 0);
				});

				// https://github.com/eslint/eslint/issues/16300
				it("should process ignore patterns relative to basePath not cwd", async () => {
					eslint = new ESLint({
						flags,
						cwd: getFixturePath("ignores-relative/subdir"),
					});
					const results = await eslint.lintFiles(["**/*.js"]);

					assert.strictEqual(results.length, 1);
					assert.strictEqual(
						results[0].filePath,
						getFixturePath("ignores-relative/subdir/a.js"),
					);
				});

				// https://github.com/eslint/eslint/issues/16354
				it("should skip subdirectory files when ignore pattern matches deep subdirectory", async () => {
					eslint = new ESLint({
						flags,
						cwd: getFixturePath("ignores-directory"),
					});

					await assert.rejects(async () => {
						await eslint.lintFiles(["subdir/**"]);
					}, /All files matched by 'subdir\/\*\*' are ignored\./u);

					await assert.rejects(async () => {
						await eslint.lintFiles(["subdir/subsubdir/**"]);
					}, /All files matched by 'subdir\/subsubdir\/\*\*' are ignored\./u);

					const results = await eslint.lintFiles([
						"subdir/subsubdir/a.js",
					]);

					assert.strictEqual(results.length, 1);
					assert.strictEqual(
						results[0].filePath,
						getFixturePath(
							"ignores-directory/subdir/subsubdir/a.js",
						),
					);
					assert.strictEqual(results[0].warningCount, 1);
					assert(
						results[0].messages[0].message.startsWith(
							"File ignored",
						),
						"Should contain file ignored warning",
					);
				});

				// https://github.com/eslint/eslint/issues/16414
				it("should skip subdirectory files when ignore pattern matches subdirectory", async () => {
					eslint = new ESLint({
						flags,
						cwd: getFixturePath("ignores-subdirectory"),
					});

					await assert.rejects(async () => {
						await eslint.lintFiles(["subdir/**/*.js"]);
					}, /All files matched by 'subdir\/\*\*\/\*\.js' are ignored\./u);

					const results = await eslint.lintFiles([
						"subdir/subsubdir/a.js",
					]);

					assert.strictEqual(results.length, 1);
					assert.strictEqual(
						results[0].filePath,
						getFixturePath(
							"ignores-subdirectory/subdir/subsubdir/a.js",
						),
					);
					assert.strictEqual(results[0].warningCount, 1);
					assert(
						results[0].messages[0].message.startsWith(
							"File ignored",
						),
						"Should contain file ignored warning",
					);

					eslint = new ESLint({
						flags,
						cwd: getFixturePath("ignores-subdirectory/subdir"),
					});

					await assert.rejects(async () => {
						await eslint.lintFiles(["subsubdir/**/*.js"]);
					}, /All files matched by 'subsubdir\/\*\*\/\*\.js' are ignored\./u);
				});

				// https://github.com/eslint/eslint/issues/16340
				it("should lint files even when cwd directory name matches ignores pattern", async () => {
					eslint = new ESLint({
						flags,
						cwd: getFixturePath("ignores-self"),
					});

					const results = await eslint.lintFiles(["*.js"]);

					assert.strictEqual(results.length, 1);
					assert.strictEqual(
						results[0].filePath,
						getFixturePath("ignores-self/eslint.config.js"),
					);
					assert.strictEqual(results[0].errorCount, 0);
					assert.strictEqual(results[0].warningCount, 0);
				});

				// https://github.com/eslint/eslint/issues/16416
				it("should allow reignoring of previously ignored files", async () => {
					eslint = new ESLint({
						flags,
						cwd: getFixturePath("ignores-relative"),
						overrideConfigFile: true,
						overrideConfig: {
							ignores: ["*.js", "!a*.js", "a.js"],
						},
					});
					const results = await eslint.lintFiles(["a.js"]);

					assert.strictEqual(results.length, 1);
					assert.strictEqual(results[0].errorCount, 0);
					assert.strictEqual(results[0].warningCount, 1);
					assert.strictEqual(
						results[0].filePath,
						getFixturePath("ignores-relative/a.js"),
					);
				});

				// https://github.com/eslint/eslint/issues/16415
				it("should allow directories to be unignored", async () => {
					eslint = new ESLint({
						flags,
						cwd: getFixturePath("ignores-directory"),
						overrideConfigFile: true,
						overrideConfig: {
							ignores: ["subdir/*", "!subdir/subsubdir"],
						},
					});
					const results = await eslint.lintFiles(["subdir/**/*.js"]);

					assert.strictEqual(results.length, 1);
					assert.strictEqual(results[0].errorCount, 0);
					assert.strictEqual(results[0].warningCount, 0);
					assert.strictEqual(
						results[0].filePath,
						getFixturePath(
							"ignores-directory/subdir/subsubdir/a.js",
						),
					);
				});

				// https://github.com/eslint/eslint/issues/17964#issuecomment-1879840650
				it("should allow directories to be unignored without also unignoring all files in them", async () => {
					eslint = new ESLint({
						flags,
						cwd: getFixturePath("ignores-directory-deep"),
						overrideConfigFile: true,
						overrideConfig: {
							ignores: [
								// ignore all files and directories
								"tests/format/**/*",

								// unignore all directories
								"!tests/format/**/*/",

								// unignore only specific files
								"!tests/format/**/jsfmt.spec.js",
							],
						},
					});
					const results = await eslint.lintFiles(["."]);

					assert.strictEqual(results.length, 2);
					assert.strictEqual(results[0].errorCount, 0);
					assert.strictEqual(results[0].warningCount, 0);
					assert.strictEqual(
						results[0].filePath,
						getFixturePath(
							"ignores-directory-deep/tests/format/jsfmt.spec.js",
						),
					);
					assert.strictEqual(results[1].errorCount, 0);
					assert.strictEqual(results[1].warningCount, 0);
					assert.strictEqual(
						results[1].filePath,
						getFixturePath(
							"ignores-directory-deep/tests/format/subdir/jsfmt.spec.js",
						),
					);
				});

				it("should allow only subdirectories to be ignored by a pattern ending with '/'", async () => {
					eslint = new ESLint({
						flags,
						cwd: getFixturePath("ignores-directory-deep"),
						overrideConfigFile: true,
						overrideConfig: {
							ignores: ["tests/format/*/"],
						},
					});
					const results = await eslint.lintFiles(["."]);

					assert.strictEqual(results.length, 2);
					assert.strictEqual(results[0].errorCount, 0);
					assert.strictEqual(results[0].warningCount, 0);
					assert.strictEqual(
						results[0].filePath,
						getFixturePath(
							"ignores-directory-deep/tests/format/foo.js",
						),
					);
					assert.strictEqual(results[1].errorCount, 0);
					assert.strictEqual(results[1].warningCount, 0);
					assert.strictEqual(
						results[1].filePath,
						getFixturePath(
							"ignores-directory-deep/tests/format/jsfmt.spec.js",
						),
					);
				});

				it("should allow only contents of a directory but not the directory itself to be ignored by a pattern ending with '**/*'", async () => {
					eslint = new ESLint({
						flags,
						cwd: getFixturePath("ignores-directory-deep"),
						overrideConfigFile: true,
						overrideConfig: {
							ignores: [
								"tests/format/**/*",
								"!tests/format/jsfmt.spec.js",
							],
						},
					});
					const results = await eslint.lintFiles(["."]);

					assert.strictEqual(results.length, 1);
					assert.strictEqual(results[0].errorCount, 0);
					assert.strictEqual(results[0].warningCount, 0);
					assert.strictEqual(
						results[0].filePath,
						getFixturePath(
							"ignores-directory-deep/tests/format/jsfmt.spec.js",
						),
					);
				});

				it("should skip ignored files in an unignored directory", async () => {
					eslint = new ESLint({
						flags,
						cwd: getFixturePath("ignores-directory-deep"),
						overrideConfigFile: true,
						overrideConfig: {
							ignores: [
								// ignore 'tests/format/' and all its contents
								"tests/format/**",

								// unignore 'tests/format/', but its contents is still ignored
								"!tests/format/",
							],
						},
					});

					await assert.rejects(async () => {
						await eslint.lintFiles(["."]);
					}, /All files matched by '.' are ignored/u);
				});

				it("should skip files in an ignored directory even if they are matched by a negated pattern", async () => {
					eslint = new ESLint({
						flags,
						cwd: getFixturePath("ignores-directory-deep"),
						overrideConfigFile: true,
						overrideConfig: {
							ignores: [
								// ignore 'tests/format/' and all its contents
								"tests/format/**",

								// this patterns match some or all of its contents, but 'tests/format/' is still ignored
								"!tests/format/jsfmt.spec.js",
								"!tests/format/**/jsfmt.spec.js",
								"!tests/format/*",
								"!tests/format/**/*",
							],
						},
					});

					await assert.rejects(async () => {
						await eslint.lintFiles(["."]);
					}, /All files matched by '.' are ignored/u);
				});

				// https://github.com/eslint/eslint/issues/18597
				it("should skip files ignored by a pattern with escape character '\\'", async () => {
					eslint = new ESLint({
						cwd: getFixturePath(),
						flags,
						overrideConfigFile: true,
						overrideConfig: [
							{
								ignores: [
									"curly-files/\\{a,b}.js", // ignore file named `{a,b}.js`, not files named `a.js` or `b.js`
								],
							},
							{
								rules: {
									"no-undef": "warn",
								},
							},
						],
					});

					const results = await eslint.lintFiles(["curly-files"]);

					assert.strictEqual(results.length, 2);
					assert.strictEqual(
						results[0].filePath,
						getFixturePath("curly-files", "a.js"),
					);
					assert.strictEqual(results[0].messages.length, 1);
					assert.strictEqual(results[0].messages[0].severity, 1);
					assert.strictEqual(
						results[0].messages[0].ruleId,
						"no-undef",
					);
					assert.strictEqual(
						results[0].messages[0].messageId,
						"undef",
					);
					assert.match(results[0].messages[0].message, /'bar'/u);
					assert.strictEqual(
						results[1].filePath,
						getFixturePath("curly-files", "b.js"),
					);
					assert.strictEqual(results[1].messages.length, 1);
					assert.strictEqual(results[1].messages[0].severity, 1);
					assert.strictEqual(
						results[1].messages[0].ruleId,
						"no-undef",
					);
					assert.strictEqual(
						results[1].messages[0].messageId,
						"undef",
					);
					assert.match(results[1].messages[0].message, /'baz'/u);
				});

				// https://github.com/eslint/eslint/issues/18706
				it("should disregard ignore pattern '/'", async () => {
					eslint = new ESLint({
						cwd: getFixturePath("ignores-relative"),
						flags,
						overrideConfigFile: true,
						overrideConfig: [
							{
								ignores: ["/"],
							},
							{
								plugins: {
									"test-plugin": {
										rules: {
											"no-program": {
												create(context) {
													return {
														Program(node) {
															context.report({
																node,
																message:
																	"Program is disallowed.",
															});
														},
													};
												},
											},
										},
									},
								},
								rules: {
									"test-plugin/no-program": "warn",
								},
							},
						],
					});

					const results = await eslint.lintFiles(["**/a.js"]);

					assert.strictEqual(results.length, 2);
					assert.strictEqual(
						results[0].filePath,
						getFixturePath("ignores-relative", "a.js"),
					);
					assert.strictEqual(results[0].messages.length, 1);
					assert.strictEqual(results[0].messages[0].severity, 1);
					assert.strictEqual(
						results[0].messages[0].ruleId,
						"test-plugin/no-program",
					);
					assert.strictEqual(
						results[0].messages[0].message,
						"Program is disallowed.",
					);
					assert.strictEqual(
						results[1].filePath,
						getFixturePath("ignores-relative", "subdir", "a.js"),
					);
					assert.strictEqual(results[1].messages.length, 1);
					assert.strictEqual(results[1].messages[0].severity, 1);
					assert.strictEqual(
						results[1].messages[0].ruleId,
						"test-plugin/no-program",
					);
					assert.strictEqual(
						results[1].messages[0].message,
						"Program is disallowed.",
					);
				});

				it("should not skip an unignored file in base path when all files are initially ignored by '**'", async () => {
					eslint = new ESLint({
						cwd: getFixturePath("ignores-relative"),
						flags,
						overrideConfigFile: true,
						overrideConfig: [
							{
								ignores: ["**", "!a.js"],
							},
							{
								plugins: {
									"test-plugin": {
										rules: {
											"no-program": {
												create(context) {
													return {
														Program(node) {
															context.report({
																node,
																message:
																	"Program is disallowed.",
															});
														},
													};
												},
											},
										},
									},
								},
								rules: {
									"test-plugin/no-program": "warn",
								},
							},
						],
					});

					const results = await eslint.lintFiles(["**/a.js"]);

					assert.strictEqual(results.length, 1);
					assert.strictEqual(
						results[0].filePath,
						getFixturePath("ignores-relative", "a.js"),
					);
					assert.strictEqual(results[0].messages.length, 1);
					assert.strictEqual(results[0].messages[0].severity, 1);
					assert.strictEqual(
						results[0].messages[0].ruleId,
						"test-plugin/no-program",
					);
					assert.strictEqual(
						results[0].messages[0].message,
						"Program is disallowed.",
					);
				});

				// https://github.com/eslint/eslint/issues/18575
				describe("on Windows", () => {
					if (os.platform() !== "win32") {
						return;
					}

					let otherDriveLetter;
					const exec = util.promisify(
						require("node:child_process").exec,
					);

					/*
					 * Map the fixture directory to a new virtual drive.
					 * Use the first drive letter available.
					 */
					before(async () => {
						const substDir = getFixturePath();

						for (const driveLetter of "ABCDEFGHIJKLMNOPQRSTUVWXYZ") {
							try {
								// More info on this command at https://en.wikipedia.org/wiki/SUBST
								await exec(
									`subst ${driveLetter}: "${substDir}"`,
								);
							} catch {
								continue;
							}
							otherDriveLetter = driveLetter;
							break;
						}
						if (!otherDriveLetter) {
							throw Error(
								"Unable to assign a virtual drive letter.",
							);
						}
					});

					/*
					 * Delete the virtual drive.
					 */
					after(async () => {
						if (otherDriveLetter) {
							try {
								await exec(`subst /D ${otherDriveLetter}:`);
							} catch ({ message }) {
								throw new Error(
									`Unable to unassign virtual drive letter ${otherDriveLetter}: - ${message}`,
								);
							}
						}
					});

					it("should return a warning when an explicitly given file is on a different drive", async () => {
						eslint = new ESLint({
							flags,
							overrideConfigFile: true,
							cwd: getFixturePath(),
						});
						const filePath = `${otherDriveLetter}:\\passing.js`;
						const results = await eslint.lintFiles([filePath]);

						assert.strictEqual(results.length, 1);
						assert.strictEqual(results[0].filePath, filePath);
						assert.strictEqual(results[0].messages[0].severity, 1);
						assert.strictEqual(
							results[0].messages[0].message,
							"File ignored because outside of base path.",
						);
						assert.strictEqual(results[0].errorCount, 0);
						assert.strictEqual(results[0].warningCount, 1);
						assert.strictEqual(results[0].fatalErrorCount, 0);
						assert.strictEqual(results[0].fixableErrorCount, 0);
						assert.strictEqual(results[0].fixableWarningCount, 0);
						assert.strictEqual(
							results[0].suppressedMessages.length,
							0,
						);
					});

					it("should not ignore an explicitly given file that is on the same drive as cwd", async () => {
						eslint = new ESLint({
							flags,
							overrideConfigFile: true,
							cwd: `${otherDriveLetter}:\\`,
						});
						const filePath = `${otherDriveLetter}:\\passing.js`;
						const results = await eslint.lintFiles([filePath]);

						assert.strictEqual(results.length, 1);
						assert.strictEqual(results[0].filePath, filePath);
						assert.strictEqual(results[0].messages.length, 0);
						assert.strictEqual(results[0].errorCount, 0);
						assert.strictEqual(results[0].warningCount, 0);
						assert.strictEqual(results[0].fatalErrorCount, 0);
						assert.strictEqual(results[0].fixableErrorCount, 0);
						assert.strictEqual(results[0].fixableWarningCount, 0);
						assert.strictEqual(
							results[0].suppressedMessages.length,
							0,
						);
					});

					it("should not ignore a file on the same drive as cwd that matches a glob pattern", async () => {
						eslint = new ESLint({
							flags,
							overrideConfigFile: true,
							cwd: `${otherDriveLetter}:\\files`,
						});
						const pattern = `${otherDriveLetter}:\\files\\???.*`;
						const results = await eslint.lintFiles([pattern]);

						assert.strictEqual(results.length, 1);
						assert.strictEqual(
							results[0].filePath,
							`${otherDriveLetter}:\\files\\foo.js`,
						);
						assert.strictEqual(results[0].messages.length, 0);
						assert.strictEqual(results[0].errorCount, 0);
						assert.strictEqual(results[0].warningCount, 0);
						assert.strictEqual(results[0].fatalErrorCount, 0);
						assert.strictEqual(results[0].fixableErrorCount, 0);
						assert.strictEqual(results[0].fixableWarningCount, 0);
						assert.strictEqual(
							results[0].suppressedMessages.length,
							0,
						);
					});

					it("should throw an error when a glob pattern matches only files on different drive", async () => {
						eslint = new ESLint({
							flags,
							overrideConfigFile: true,
							cwd: getFixturePath(),
						});
						const pattern = `${otherDriveLetter}:\\pa**ng.*`;

						await assert.rejects(
							eslint.lintFiles([pattern]),
							`All files matched by '${otherDriveLetter}:\\pa**ng.*' are ignored.`,
						);
					});
				});
			});

			it("should report zero messages when given a pattern with a .js and a .js2 file", async () => {
				eslint = new ESLint({
					flags,
					overrideConfig: { files: ["**/*.js", "**/*.js2"] },
					ignore: false,
					cwd: path.join(fixtureDir, ".."),
					overrideConfigFile: true,
				});
				const results = await eslint.lintFiles([
					"fixtures/files/*.?s*",
				]);

				assert.strictEqual(results.length, 3);
				assert.strictEqual(results[0].messages.length, 0);
				assert.strictEqual(results[0].suppressedMessages.length, 0);
				assert.strictEqual(results[1].messages.length, 0);
				assert.strictEqual(results[1].suppressedMessages.length, 0);
				assert.strictEqual(results[2].messages.length, 0);
				assert.strictEqual(results[2].suppressedMessages.length, 0);
			});

			it("should return one error message when given a config with rules with options and severity level set to error", async () => {
				eslint = new ESLint({
					flags,
					cwd: getFixturePath(),
					overrideConfigFile: true,
					overrideConfig: {
						rules: {
							quotes: ["error", "double"],
						},
					},
					ignore: false,
				});
				const results = await eslint.lintFiles([
					getFixturePath("single-quoted.js"),
				]);

				assert.strictEqual(results.length, 1);
				assert.strictEqual(results[0].messages.length, 1);
				assert.strictEqual(results[0].messages[0].ruleId, "quotes");
				assert.strictEqual(results[0].messages[0].severity, 2);
				assert.strictEqual(results[0].errorCount, 1);
				assert.strictEqual(results[0].warningCount, 0);
				assert.strictEqual(results[0].fatalErrorCount, 0);
				assert.strictEqual(results[0].fixableErrorCount, 1);
				assert.strictEqual(results[0].fixableWarningCount, 0);
				assert.strictEqual(results[0].suppressedMessages.length, 0);
			});

			it("should return 5 results when given a config and a directory of 5 valid files", async () => {
				eslint = new ESLint({
					flags,
					cwd: path.join(fixtureDir, ".."),
					overrideConfigFile: true,
					overrideConfig: {
						rules: {
							semi: 1,
							strict: 0,
						},
					},
				});

				const formattersDir = getFixturePath("formatters");
				const results = await eslint.lintFiles([formattersDir]);

				assert.strictEqual(results.length, 5);
				assert.strictEqual(
					path.relative(formattersDir, results[0].filePath),
					"async.js",
				);
				assert.strictEqual(results[0].errorCount, 0);
				assert.strictEqual(results[0].warningCount, 0);
				assert.strictEqual(results[0].fatalErrorCount, 0);
				assert.strictEqual(results[0].fixableErrorCount, 0);
				assert.strictEqual(results[0].fixableWarningCount, 0);
				assert.strictEqual(results[0].messages.length, 0);
				assert.strictEqual(results[0].suppressedMessages.length, 0);
				assert.strictEqual(
					path.relative(formattersDir, results[1].filePath),
					"broken.js",
				);
				assert.strictEqual(results[1].errorCount, 0);
				assert.strictEqual(results[1].warningCount, 0);
				assert.strictEqual(results[1].fatalErrorCount, 0);
				assert.strictEqual(results[1].fixableErrorCount, 0);
				assert.strictEqual(results[1].fixableWarningCount, 0);
				assert.strictEqual(results[1].messages.length, 0);
				assert.strictEqual(results[1].suppressedMessages.length, 0);
				assert.strictEqual(
					path.relative(formattersDir, results[2].filePath),
					"cwd.js",
				);
				assert.strictEqual(results[2].errorCount, 0);
				assert.strictEqual(results[2].warningCount, 0);
				assert.strictEqual(results[2].fatalErrorCount, 0);
				assert.strictEqual(results[2].fixableErrorCount, 0);
				assert.strictEqual(results[2].fixableWarningCount, 0);
				assert.strictEqual(results[2].messages.length, 0);
				assert.strictEqual(results[2].suppressedMessages.length, 0);
				assert.strictEqual(
					path.relative(formattersDir, results[3].filePath),
					"simple.js",
				);
				assert.strictEqual(results[3].errorCount, 0);
				assert.strictEqual(results[3].warningCount, 0);
				assert.strictEqual(results[3].fatalErrorCount, 0);
				assert.strictEqual(results[3].fixableErrorCount, 0);
				assert.strictEqual(results[3].fixableWarningCount, 0);
				assert.strictEqual(results[3].messages.length, 0);
				assert.strictEqual(results[3].suppressedMessages.length, 0);
				assert.strictEqual(
					path.relative(formattersDir, results[4].filePath),
					path.join("test", "simple.js"),
				);
				assert.strictEqual(results[4].errorCount, 0);
				assert.strictEqual(results[4].warningCount, 0);
				assert.strictEqual(results[4].fatalErrorCount, 0);
				assert.strictEqual(results[4].fixableErrorCount, 0);
				assert.strictEqual(results[4].fixableWarningCount, 0);
				assert.strictEqual(results[4].messages.length, 0);
				assert.strictEqual(results[4].suppressedMessages.length, 0);
			});

			it("should return zero messages when given a config with browser globals", async () => {
				eslint = new ESLint({
					flags,
					cwd: path.join(fixtureDir, ".."),
					overrideConfigFile: getFixturePath(
						"configurations",
						"env-browser.js",
					),
				});
				const results = await eslint.lintFiles([
					fs.realpathSync(getFixturePath("globals-browser.js")),
				]);

				assert.strictEqual(results.length, 1);
				assert.strictEqual(
					results[0].messages.length,
					0,
					"Should have no messages.",
				);
				assert.strictEqual(results[0].suppressedMessages.length, 0);
			});

			it("should return zero messages when given an option to add browser globals", async () => {
				eslint = new ESLint({
					flags,
					cwd: path.join(fixtureDir, ".."),
					overrideConfigFile: true,
					overrideConfig: {
						languageOptions: {
							globals: {
								window: false,
							},
						},
						rules: {
							"no-alert": 0,
							"no-undef": 2,
						},
					},
				});
				const results = await eslint.lintFiles([
					fs.realpathSync(getFixturePath("globals-browser.js")),
				]);

				assert.strictEqual(results.length, 1);
				assert.strictEqual(results[0].messages.length, 0);
				assert.strictEqual(results[0].suppressedMessages.length, 0);
			});

			it("should return zero messages when given a config with sourceType set to commonjs and Node.js globals", async () => {
				eslint = new ESLint({
					flags,
					cwd: path.join(fixtureDir, ".."),
					overrideConfigFile: getFixturePath(
						"configurations",
						"env-node.js",
					),
				});
				const results = await eslint.lintFiles([
					fs.realpathSync(getFixturePath("globals-node.js")),
				]);

				assert.strictEqual(results.length, 1);
				assert.strictEqual(
					results[0].messages.length,
					0,
					"Should have no messages.",
				);
				assert.strictEqual(results[0].suppressedMessages.length, 0);
			});

			it("should not return results from previous call when calling more than once", async () => {
				eslint = new ESLint({
					flags,
					cwd: path.join(fixtureDir, ".."),
					overrideConfigFile: getFixturePath("eslint.config.js"),
					ignore: false,
					overrideConfig: {
						rules: {
							semi: 2,
						},
					},
				});
				const failFilePath = fs.realpathSync(
					getFixturePath("missing-semicolon.js"),
				);
				const passFilePath = fs.realpathSync(
					getFixturePath("passing.js"),
				);

				let results = await eslint.lintFiles([failFilePath]);

				assert.strictEqual(results.length, 1);
				assert.strictEqual(results[0].filePath, failFilePath);
				assert.strictEqual(results[0].messages.length, 1);
				assert.strictEqual(results[0].messages[0].ruleId, "semi");
				assert.strictEqual(results[0].suppressedMessages.length, 0);
				assert.strictEqual(results[0].messages[0].severity, 2);

				results = await eslint.lintFiles([passFilePath]);
				assert.strictEqual(results.length, 1);
				assert.strictEqual(results[0].filePath, passFilePath);
				assert.strictEqual(results[0].messages.length, 0);
				assert.strictEqual(results[0].suppressedMessages.length, 0);
			});

			it("should return zero messages when executing a file with a shebang", async () => {
				eslint = new ESLint({
					flags,
					ignore: false,
					cwd: getFixturePath(),
					overrideConfigFile: getFixturePath("eslint.config.js"),
				});
				const results = await eslint.lintFiles([
					getFixturePath("shebang.js"),
				]);

				assert.strictEqual(results.length, 1);
				assert.strictEqual(
					results[0].messages.length,
					0,
					"Should have lint messages.",
				);
				assert.strictEqual(results[0].suppressedMessages.length, 0);
			});

			it("should return zero messages when executing without a config file", async () => {
				eslint = new ESLint({
					flags,
					cwd: getFixturePath(),
					ignore: false,
					overrideConfigFile: true,
				});
				const filePath = fs.realpathSync(
					getFixturePath("missing-semicolon.js"),
				);
				const results = await eslint.lintFiles([filePath]);

				assert.strictEqual(results.length, 1);
				assert.strictEqual(results[0].filePath, filePath);
				assert.strictEqual(results[0].messages.length, 0);
				assert.strictEqual(results[0].suppressedMessages.length, 0);
			});

			// working
			describe("Deprecated Rules", () => {
				it("should warn when deprecated rules are configured", async () => {
					eslint = new ESLint({
						flags,
						cwd: originalDir,
						overrideConfigFile: true,
						overrideConfig: {
							plugins: {
								test: {
									rules: {
										"deprecated-with-replacement": {
											meta: {
												deprecated: true,
												replacedBy: ["replacement"],
											},
											create: () => ({}),
										},
										"deprecated-without-replacement": {
											meta: { deprecated: true },
											create: () => ({}),
										},
									},
								},
							},
							rules: {
								"test/deprecated-with-replacement": "error",
								"test/deprecated-without-replacement": "error",
							},
						},
					});
					const results = await eslint.lintFiles(["lib/cli*.js"]);

					assert.deepStrictEqual(results[0].usedDeprecatedRules, [
						{
							ruleId: "test/deprecated-with-replacement",
							replacedBy: ["replacement"],
							info: void 0,
						},
						{
							ruleId: "test/deprecated-without-replacement",
							replacedBy: [],
							info: void 0,
						},
					]);
				});

				it("should not warn when deprecated rules are not configured", async () => {
					eslint = new ESLint({
						flags,
						cwd: originalDir,
						overrideConfigFile: true,
						overrideConfig: {
							rules: { eqeqeq: 1, "callback-return": 0 },
						},
					});
					const results = await eslint.lintFiles(["lib/cli*.js"]);

					assert.deepStrictEqual(results[0].usedDeprecatedRules, []);
				});

				it("should warn when deprecated rules are found in a config", async () => {
					eslint = new ESLint({
						flags,
						cwd: originalDir,
						overrideConfigFile:
							"tests/fixtures/cli-engine/deprecated-rule-config/eslint.config.js",
					});
					const results = await eslint.lintFiles(["lib/cli*.js"]);

					assert.deepStrictEqual(results[0].usedDeprecatedRules, [
						{
							ruleId: "indent-legacy",
							replacedBy: ["@stylistic/indent"],
							info: coreRules.get("indent-legacy").meta
								.deprecated,
						},
					]);
				});

				it("should add the plugin name to the replacement if available", async () => {
					const deprecated = {
						message: "Deprecation",
						url: "https://example.com",
						replacedBy: [
							{
								message: "Replacement",
								plugin: { name: "plugin" },
								rule: { name: "name" },
							},
						],
					};

					eslint = new ESLint({
						flags,
						cwd: originalDir,
						overrideConfigFile: true,
						overrideConfig: {
							plugins: {
								test: {
									rules: {
										deprecated: {
											meta: { deprecated },
											create: () => ({}),
										},
									},
								},
							},
							rules: {
								"test/deprecated": "error",
							},
						},
					});
					const results = await eslint.lintFiles(["lib/cli*.js"]);

					assert.deepStrictEqual(results[0].usedDeprecatedRules, [
						{
							ruleId: "test/deprecated",
							replacedBy: ["plugin/name"],
							info: deprecated,
						},
					]);
				});
			});

			// working
			describe("Fix Mode", () => {
				it("correctly autofixes semicolon-conflicting-fixes", async () => {
					eslint = new ESLint({
						flags,
						cwd: path.join(fixtureDir, ".."),
						overrideConfigFile: true,
						fix: true,
					});
					const inputPath = getFixturePath(
						"autofix/semicolon-conflicting-fixes.js",
					);
					const outputPath = getFixturePath(
						"autofix/semicolon-conflicting-fixes.expected.js",
					);
					const results = await eslint.lintFiles([inputPath]);
					const expectedOutput = fs.readFileSync(outputPath, "utf8");

					assert.strictEqual(results[0].output, expectedOutput);
				});

				it("correctly autofixes return-conflicting-fixes", async () => {
					eslint = new ESLint({
						flags,
						cwd: path.join(fixtureDir, ".."),
						overrideConfigFile: true,
						fix: true,
					});
					const inputPath = getFixturePath(
						"autofix/return-conflicting-fixes.js",
					);
					const outputPath = getFixturePath(
						"autofix/return-conflicting-fixes.expected.js",
					);
					const results = await eslint.lintFiles([inputPath]);
					const expectedOutput = fs.readFileSync(outputPath, "utf8");

					assert.strictEqual(results[0].output, expectedOutput);
				});

				it("should return fixed text on multiple files when in fix mode", async () => {
					/**
					 * Converts CRLF to LF in output.
					 * This is a workaround for git's autocrlf option on Windows.
					 * @param {Object} result A result object to convert.
					 * @returns {void}
					 */
					function convertCRLF(result) {
						if (result && result.output) {
							result.output = result.output.replace(
								/\r\n/gu,
								"\n",
							);
						}
					}

					eslint = new ESLint({
						flags,
						cwd: path.join(fixtureDir, ".."),
						overrideConfigFile: true,
						fix: true,
						overrideConfig: {
							rules: {
								semi: 2,
								quotes: [2, "double"],
								eqeqeq: 2,
								"no-undef": 2,
								"space-infix-ops": 2,
							},
						},
					});
					const results = await eslint.lintFiles([
						path.resolve(fixtureDir, `${fixtureDir}/fixmode`),
					]);

					results.forEach(convertCRLF);
					assert.deepStrictEqual(results, [
						{
							filePath: fs.realpathSync(
								path.resolve(
									fixtureDir,
									"fixmode/multipass.js",
								),
							),
							messages: [],
							suppressedMessages: [],
							errorCount: 0,
							warningCount: 0,
							fatalErrorCount: 0,
							fixableErrorCount: 0,
							fixableWarningCount: 0,
							output: 'true ? "yes" : "no";\n',
							usedDeprecatedRules: [
								{
									ruleId: "semi",
									replacedBy: ["@stylistic/semi"],
									info: coreRules.get("semi").meta.deprecated,
								},
								{
									ruleId: "quotes",
									replacedBy: ["@stylistic/quotes"],
									info: coreRules.get("quotes").meta
										.deprecated,
								},
								{
									ruleId: "space-infix-ops",
									replacedBy: ["@stylistic/space-infix-ops"],
									info: coreRules.get("space-infix-ops").meta
										.deprecated,
								},
							],
						},
						{
							filePath: fs.realpathSync(
								path.resolve(fixtureDir, "fixmode/ok.js"),
							),
							messages: [],
							suppressedMessages: [],
							errorCount: 0,
							warningCount: 0,
							fatalErrorCount: 0,
							fixableErrorCount: 0,
							fixableWarningCount: 0,
							usedDeprecatedRules: [
								{
									ruleId: "semi",
									replacedBy: ["@stylistic/semi"],
									info: coreRules.get("semi").meta.deprecated,
								},
								{
									ruleId: "quotes",
									replacedBy: ["@stylistic/quotes"],
									info: coreRules.get("quotes").meta
										.deprecated,
								},
								{
									ruleId: "space-infix-ops",
									replacedBy: ["@stylistic/space-infix-ops"],
									info: coreRules.get("space-infix-ops").meta
										.deprecated,
								},
							],
						},
						{
							filePath: fs.realpathSync(
								path.resolve(
									fixtureDir,
									"fixmode/quotes-semi-eqeqeq.js",
								),
							),
							messages: [
								{
									column: 9,
									line: 2,
									endColumn: 11,
									endLine: 2,
									message:
										"Expected '===' and instead saw '=='.",
									messageId: "unexpected",
									nodeType: "BinaryExpression",
									ruleId: "eqeqeq",
									severity: 2,
									suggestions: [
										{
											data: {
												actualOperator: "==",
												expectedOperator: "===",
											},
											desc: "Use '===' instead of '=='.",
											fix: {
												range: [24, 26],
												text: "===",
											},
											messageId: "replaceOperator",
										},
									],
								},
							],
							suppressedMessages: [],
							errorCount: 1,
							warningCount: 0,
							fatalErrorCount: 0,
							fixableErrorCount: 0,
							fixableWarningCount: 0,
							output: 'var msg = "hi";\nif (msg == "hi") {\n\n}\n',
							usedDeprecatedRules: [
								{
									ruleId: "semi",
									replacedBy: ["@stylistic/semi"],
									info: coreRules.get("semi").meta.deprecated,
								},
								{
									ruleId: "quotes",
									replacedBy: ["@stylistic/quotes"],
									info: coreRules.get("quotes").meta
										.deprecated,
								},
								{
									ruleId: "space-infix-ops",
									replacedBy: ["@stylistic/space-infix-ops"],
									info: coreRules.get("space-infix-ops").meta
										.deprecated,
								},
							],
						},
						{
							filePath: fs.realpathSync(
								path.resolve(fixtureDir, "fixmode/quotes.js"),
							),
							messages: [
								{
									column: 18,
									line: 1,
									endColumn: 21,
									endLine: 1,
									messageId: "undef",
									message: "'foo' is not defined.",
									nodeType: "Identifier",
									ruleId: "no-undef",
									severity: 2,
								},
							],
							suppressedMessages: [],
							errorCount: 1,
							warningCount: 0,
							fatalErrorCount: 0,
							fixableErrorCount: 0,
							fixableWarningCount: 0,
							output: 'var msg = "hi" + foo;\n',
							usedDeprecatedRules: [
								{
									ruleId: "semi",
									replacedBy: ["@stylistic/semi"],
									info: coreRules.get("semi").meta.deprecated,
								},
								{
									ruleId: "quotes",
									replacedBy: ["@stylistic/quotes"],
									info: coreRules.get("quotes").meta
										.deprecated,
								},
								{
									ruleId: "space-infix-ops",
									replacedBy: ["@stylistic/space-infix-ops"],
									info: coreRules.get("space-infix-ops").meta
										.deprecated,
								},
							],
						},
					]);
				});

				// Cannot be run properly until cache is implemented
				it("should run autofix even if files are cached without autofix results", async () => {
					const baseOptions = {
						flags,
						cwd: path.join(fixtureDir, ".."),
						overrideConfigFile: true,
						overrideConfig: {
							rules: {
								semi: 2,
								quotes: [2, "double"],
								eqeqeq: 2,
								"no-undef": 2,
								"space-infix-ops": 2,
							},
						},
					};

					eslint = new ESLint(
						Object.assign({}, baseOptions, {
							cache: true,
							fix: false,
						}),
					);

					// Do initial lint run and populate the cache file
					await eslint.lintFiles([
						path.resolve(fixtureDir, `${fixtureDir}/fixmode`),
					]);

					eslint = new ESLint(
						Object.assign({}, baseOptions, {
							cache: true,
							fix: true,
						}),
					);
					const results = await eslint.lintFiles([
						path.resolve(fixtureDir, `${fixtureDir}/fixmode`),
					]);

					assert(results.some(result => result.output));
				});
			});

			describe("plugins", () => {
				it("should return two messages when executing with config file that specifies a plugin", async () => {
					eslint = eslintWithPlugins({
						flags,
						cwd: path.resolve(fixtureDir, ".."),
						overrideConfigFile: getFixturePath(
							"configurations",
							"plugins-with-prefix.js",
						),
					});
					const results = await eslint.lintFiles([
						fs.realpathSync(
							getFixturePath("rules", "test/test-custom-rule.js"),
						),
					]);

					assert.strictEqual(results.length, 1);
					assert.strictEqual(
						results[0].messages.length,
						2,
						"Expected two messages.",
					);
					assert.strictEqual(
						results[0].messages[0].ruleId,
						"example/example-rule",
					);
					assert.strictEqual(results[0].suppressedMessages.length, 0);
				});

				it("should return two messages when executing with cli option that specifies a plugin", async () => {
					eslint = eslintWithPlugins({
						flags,
						cwd: path.resolve(fixtureDir, ".."),
						overrideConfigFile: true,
						overrideConfig: {
							rules: { "example/example-rule": 1 },
						},
					});
					const results = await eslint.lintFiles([
						fs.realpathSync(
							getFixturePath(
								"rules",
								"test",
								"test-custom-rule.js",
							),
						),
					]);

					assert.strictEqual(results.length, 1);
					assert.strictEqual(results[0].messages.length, 2);
					assert.strictEqual(
						results[0].messages[0].ruleId,
						"example/example-rule",
					);
					assert.strictEqual(results[0].suppressedMessages.length, 0);
				});

				it("should return two messages when executing with cli option that specifies preloaded plugin", async () => {
					eslint = new ESLint({
						flags,
						cwd: path.resolve(fixtureDir, ".."),
						overrideConfigFile: true,
						overrideConfig: {
							rules: { "test/example-rule": 1 },
						},
						plugins: {
							"eslint-plugin-test": {
								rules: {
									"example-rule": require("../../fixtures/rules/custom-rule"),
								},
							},
						},
					});
					const results = await eslint.lintFiles([
						fs.realpathSync(
							getFixturePath(
								"rules",
								"test",
								"test-custom-rule.js",
							),
						),
					]);

					assert.strictEqual(results.length, 1);
					assert.strictEqual(results[0].messages.length, 2);
					assert.strictEqual(
						results[0].messages[0].ruleId,
						"test/example-rule",
					);
					assert.strictEqual(results[0].suppressedMessages.length, 0);
				});
			});

			describe("processors", () => {
				it("should return two messages when executing with config file that specifies preloaded processor", async () => {
					eslint = new ESLint({
						flags,
						overrideConfigFile: true,
						overrideConfig: [
							{
								plugins: {
									test: {
										processors: {
											txt: {
												preprocess(text) {
													return [text];
												},
												postprocess(messages) {
													return messages[0];
												},
											},
										},
									},
								},
								processor: "test/txt",
								rules: {
									"no-console": 2,
									"no-unused-vars": 2,
								},
							},
							{
								files: ["**/*.txt", "**/*.txt/*.txt"],
							},
						],
						cwd: path.join(fixtureDir, ".."),
					});
					const results = await eslint.lintFiles([
						fs.realpathSync(
							getFixturePath(
								"processors",
								"test",
								"test-processor.txt",
							),
						),
					]);

					assert.strictEqual(results.length, 1);
					assert.strictEqual(results[0].messages.length, 2);
					assert.strictEqual(results[0].suppressedMessages.length, 0);
				});

				it("should run processors when calling lintFiles with config file that specifies preloaded processor", async () => {
					eslint = new ESLint({
						flags,
						overrideConfigFile: true,
						overrideConfig: [
							{
								plugins: {
									test: {
										processors: {
											txt: {
												preprocess(text) {
													return [
														text.replace(
															"a()",
															"b()",
														),
													];
												},
												postprocess(messages) {
													messages[0][0].ruleId =
														"post-processed";
													return messages[0];
												},
											},
										},
									},
								},
								processor: "test/txt",
								rules: {
									"no-console": 2,
									"no-unused-vars": 2,
								},
							},
							{
								files: ["**/*.txt", "**/*.txt/*.txt"],
							},
						],
						cwd: path.join(fixtureDir, ".."),
					});
					const results = await eslint.lintFiles([
						getFixturePath(
							"processors",
							"test",
							"test-processor.txt",
						),
					]);

					assert.strictEqual(
						results[0].messages[0].message,
						"'b' is defined but never used.",
					);
					assert.strictEqual(
						results[0].messages[0].ruleId,
						"post-processed",
					);
					assert.strictEqual(results[0].suppressedMessages.length, 0);
				});

				it("should run processors when calling lintText with config file that specifies preloaded processor", async () => {
					eslint = new ESLint({
						flags,
						overrideConfigFile: true,
						overrideConfig: [
							{
								plugins: {
									test: {
										processors: {
											txt: {
												preprocess(text) {
													return [
														text.replace(
															"a()",
															"b()",
														),
													];
												},
												postprocess(messages) {
													messages[0][0].ruleId =
														"post-processed";
													return messages[0];
												},
											},
										},
									},
								},
								processor: "test/txt",
								rules: {
									"no-console": 2,
									"no-unused-vars": 2,
								},
							},
							{
								files: ["**/*.txt", "**/*.txt/*.txt"],
							},
						],
						ignore: false,
					});
					const results = await eslint.lintText(
						'function a() {console.log("Test");}',
						{
							filePath:
								"tests/fixtures/processors/test/test-processor.txt",
						},
					);

					assert.strictEqual(
						results[0].messages[0].message,
						"'b' is defined but never used.",
					);
					assert.strictEqual(
						results[0].messages[0].ruleId,
						"post-processed",
					);
					assert.strictEqual(results[0].suppressedMessages.length, 0);
				});

				it("should run processors when calling lintText with processor resolves same extension but different content correctly", async () => {
					let count = 0;

					eslint = new ESLint({
						flags,
						overrideConfigFile: true,
						overrideConfig: [
							{
								plugins: {
									test: {
										processors: {
											txt: {
												preprocess(text) {
													count++;
													return [
														{
															// it will be run twice, and text will be as-is at the second time, then it will not run third time
															text: text.replace(
																"a()",
																"b()",
															),
															filename: ".txt",
														},
													];
												},
												postprocess(messages) {
													messages[0][0].ruleId =
														"post-processed";
													return messages[0];
												},
											},
										},
									},
								},
								processor: "test/txt",
							},
							{
								files: ["**/*.txt/*.txt"],
								rules: {
									"no-console": 2,
									"no-unused-vars": 2,
								},
							},
							{
								files: ["**/*.txt"],
							},
						],
						ignore: false,
					});
					const results = await eslint.lintText(
						'function a() {console.log("Test");}',
						{
							filePath:
								"tests/fixtures/processors/test/test-processor.txt",
						},
					);

					assert.strictEqual(count, 2);
					assert.strictEqual(
						results[0].messages[0].message,
						"'b' is defined but never used.",
					);
					assert.strictEqual(
						results[0].messages[0].ruleId,
						"post-processed",
					);
					assert.strictEqual(results[0].suppressedMessages.length, 0);
				});

				// https://github.com/eslint/markdown/blob/main/rfcs/configure-file-name-from-block-meta.md#name-uniqueness
				it("should allow processors to return filenames with a slash and treat them as subpaths", async () => {
					eslint = new ESLint({
						flags,
						overrideConfigFile: true,
						overrideConfig: [
							{
								plugins: {
									test: {
										processors: {
											txt: {
												preprocess(input) {
													return input
														.split(" ")
														.map((text, index) => ({
															filename: `example-${index}/a.js`,
															text,
														}));
												},
												postprocess(messagesList) {
													return messagesList.flat();
												},
											},
										},
										rules: {
											"test-rule": {
												meta: {},
												create(context) {
													return {
														Identifier(node) {
															context.report({
																node,
																message: `filename: ${context.filename} physicalFilename: ${context.physicalFilename} identifier: ${node.name}`,
															});
														},
													};
												},
											},
										},
									},
								},
							},
							{
								files: ["**/*.txt"],
								processor: "test/txt",
							},
							{
								files: ["**/a.js"],
								rules: {
									"test/test-rule": "error",
								},
							},
						],
						cwd: path.join(fixtureDir, ".."),
					});
					const filename = getFixturePath(
						"processors",
						"test",
						"test-subpath.txt",
					);
					const [result] = await eslint.lintFiles([filename]);

					assert.strictEqual(result.messages.length, 3);

					assert.strictEqual(
						result.messages[0].ruleId,
						"test/test-rule",
					);
					assert.strictEqual(
						result.messages[0].message,
						`filename: ${path.join(filename, "0_example-0", "a.js")} physicalFilename: ${filename} identifier: foo`,
					);
					assert.strictEqual(
						result.messages[1].ruleId,
						"test/test-rule",
					);
					assert.strictEqual(
						result.messages[1].message,
						`filename: ${path.join(filename, "1_example-1", "a.js")} physicalFilename: ${filename} identifier: bar`,
					);
					assert.strictEqual(
						result.messages[2].ruleId,
						"test/test-rule",
					);
					assert.strictEqual(
						result.messages[2].message,
						`filename: ${path.join(filename, "2_example-2", "a.js")} physicalFilename: ${filename} identifier: baz`,
					);

					assert.strictEqual(result.suppressedMessages.length, 0);
				});

				describe("autofixing with processors", () => {
					const HTML_PROCESSOR = Object.freeze({
						preprocess(text) {
							return [
								text
									.replace(/^<script>/u, "")
									.replace(/<\/script>$/u, ""),
							];
						},
						postprocess(problemLists) {
							return problemLists[0].map(problem => {
								if (problem.fix) {
									const updatedFix = Object.assign(
										{},
										problem.fix,
										{
											range: problem.fix.range.map(
												index =>
													index + "<script>".length,
											),
										},
									);

									return Object.assign({}, problem, {
										fix: updatedFix,
									});
								}
								return problem;
							});
						},
					});

					it("should run in autofix mode when using a processor that supports autofixing", async () => {
						eslint = new ESLint({
							flags,
							overrideConfigFile: true,
							overrideConfig: [
								{
									files: ["**/*.html"],
									plugins: {
										test: {
											processors: {
												html: Object.assign(
													{ supportsAutofix: true },
													HTML_PROCESSOR,
												),
											},
										},
									},
									processor: "test/html",
									rules: {
										semi: 2,
									},
								},
								{
									files: ["**/*.txt"],
								},
							],
							ignore: false,
							fix: true,
						});
						const results = await eslint.lintText(
							"<script>foo</script>",
							{ filePath: "foo.html" },
						);

						assert.strictEqual(results[0].messages.length, 0);
						assert.strictEqual(
							results[0].suppressedMessages.length,
							0,
						);
						assert.strictEqual(
							results[0].output,
							"<script>foo;</script>",
						);
					});

					it("should not run in autofix mode when using a processor that does not support autofixing", async () => {
						eslint = new ESLint({
							flags,
							overrideConfigFile: true,
							overrideConfig: {
								files: ["**/*.html"],
								plugins: {
									test: {
										processors: { html: HTML_PROCESSOR },
									},
								},
								processor: "test/html",
								rules: {
									semi: 2,
								},
							},
							ignore: false,
							fix: true,
						});
						const results = await eslint.lintText(
							"<script>foo</script>",
							{ filePath: "foo.html" },
						);

						assert.strictEqual(results[0].messages.length, 1);
						assert.strictEqual(
							results[0].suppressedMessages.length,
							0,
						);
						assert(!Object.hasOwn(results[0], "output"));
					});

					it("should not run in autofix mode when `fix: true` is not provided, even if the processor supports autofixing", async () => {
						eslint = new ESLint({
							flags,
							overrideConfigFile: true,
							overrideConfig: [
								{
									files: ["**/*.html"],
									plugins: {
										test: {
											processors: {
												html: Object.assign(
													{ supportsAutofix: true },
													HTML_PROCESSOR,
												),
											},
										},
									},
									processor: "test/html",
									rules: {
										semi: 2,
									},
								},
								{
									files: ["**/*.txt"],
								},
							],
							ignore: false,
						});
						const results = await eslint.lintText(
							"<script>foo</script>",
							{ filePath: "foo.html" },
						);

						assert.strictEqual(results[0].messages.length, 1);
						assert.strictEqual(
							results[0].suppressedMessages.length,
							0,
						);
						assert(!Object.hasOwn(results[0], "output"));
					});
				});

				describe("matching and ignoring code blocks", () => {
					const pluginConfig = {
						files: ["**/*.md"],
						plugins: {
							markdown: exampleMarkdownPlugin,
						},
						processor: "markdown/markdown",
					};
					const text = unIndent`
                        \`\`\`js
                        foo_js
                        \`\`\`

                        \`\`\`ts
                        foo_ts
                        \`\`\`

                        \`\`\`cjs
                        foo_cjs
                        \`\`\`

                        \`\`\`mjs
                        foo_mjs
                        \`\`\`
                    `;

					it("should by default lint only .js, .mjs, and .cjs virtual files", async () => {
						eslint = new ESLint({
							flags,
							overrideConfigFile: true,
							overrideConfig: [
								pluginConfig,
								{
									rules: {
										"no-undef": 2,
									},
								},
							],
						});
						const [result] = await eslint.lintText(text, {
							filePath: "foo.md",
						});

						assert.strictEqual(result.messages.length, 3);
						assert.strictEqual(
							result.messages[0].ruleId,
							"no-undef",
						);
						assert.match(result.messages[0].message, /foo_js/u);
						assert.strictEqual(result.messages[0].line, 2);
						assert.strictEqual(
							result.messages[1].ruleId,
							"no-undef",
						);
						assert.match(result.messages[1].message, /foo_cjs/u);
						assert.strictEqual(result.messages[1].line, 10);
						assert.strictEqual(
							result.messages[2].ruleId,
							"no-undef",
						);
						assert.match(result.messages[2].message, /foo_mjs/u);
						assert.strictEqual(result.messages[2].line, 14);
					});

					it("should lint additional virtual files that match non-universal patterns", async () => {
						eslint = new ESLint({
							flags,
							overrideConfigFile: true,
							overrideConfig: [
								pluginConfig,
								{
									rules: {
										"no-undef": 2,
									},
								},
								{
									files: ["**/*.ts"],
								},
							],
						});
						const [result] = await eslint.lintText(text, {
							filePath: "foo.md",
						});

						assert.strictEqual(result.messages.length, 4);
						assert.strictEqual(
							result.messages[0].ruleId,
							"no-undef",
						);
						assert.match(result.messages[0].message, /foo_js/u);
						assert.strictEqual(result.messages[0].line, 2);
						assert.strictEqual(
							result.messages[1].ruleId,
							"no-undef",
						);
						assert.match(result.messages[1].message, /foo_ts/u);
						assert.strictEqual(result.messages[1].line, 6);
						assert.strictEqual(
							result.messages[2].ruleId,
							"no-undef",
						);
						assert.match(result.messages[2].message, /foo_cjs/u);
						assert.strictEqual(result.messages[2].line, 10);
						assert.strictEqual(
							result.messages[3].ruleId,
							"no-undef",
						);
						assert.match(result.messages[3].message, /foo_mjs/u);
						assert.strictEqual(result.messages[3].line, 14);
					});

					// https://github.com/eslint/eslint/issues/18493
					it("should silently skip virtual files that match only universal patterns", async () => {
						eslint = new ESLint({
							flags,
							overrideConfigFile: true,
							overrideConfig: [
								pluginConfig,
								{
									files: ["**/*"],
									rules: {
										"no-undef": 2,
									},
								},
							],
						});
						const [result] = await eslint.lintText(text, {
							filePath: "foo.md",
						});

						assert.strictEqual(result.messages.length, 3);
						assert.strictEqual(
							result.messages[0].ruleId,
							"no-undef",
						);
						assert.match(result.messages[0].message, /foo_js/u);
						assert.strictEqual(result.messages[0].line, 2);
						assert.strictEqual(
							result.messages[1].ruleId,
							"no-undef",
						);
						assert.match(result.messages[1].message, /foo_cjs/u);
						assert.strictEqual(result.messages[1].line, 10);
						assert.strictEqual(
							result.messages[2].ruleId,
							"no-undef",
						);
						assert.match(result.messages[2].message, /foo_mjs/u);
						assert.strictEqual(result.messages[2].line, 14);
					});

					it("should silently skip virtual files that are ignored by global ignores", async () => {
						eslint = new ESLint({
							flags,
							overrideConfigFile: true,
							overrideConfig: [
								pluginConfig,
								{
									rules: {
										"no-undef": 2,
									},
								},
								{
									ignores: ["**/*.cjs"],
								},
							],
						});
						const [result] = await eslint.lintText(text, {
							filePath: "foo.md",
						});

						assert.strictEqual(result.messages.length, 2);
						assert.strictEqual(
							result.messages[0].ruleId,
							"no-undef",
						);
						assert.match(result.messages[0].message, /foo_js/u);
						assert.strictEqual(result.messages[0].line, 2);
						assert.strictEqual(
							result.messages[1].ruleId,
							"no-undef",
						);
						assert.match(result.messages[1].message, /foo_mjs/u);
						assert.strictEqual(result.messages[1].line, 14);
					});

					// https://github.com/eslint/eslint/issues/15949
					it("should silently skip virtual files that are ignored by global ignores even if they match non-universal patterns", async () => {
						eslint = new ESLint({
							flags,
							overrideConfigFile: true,
							overrideConfig: [
								pluginConfig,
								{
									rules: {
										"no-undef": 2,
									},
								},
								{
									files: ["**/*.ts"],
								},
								{
									ignores: ["**/*.md/*.ts"],
								},
							],
						});
						const [result] = await eslint.lintText(text, {
							filePath: "foo.md",
						});

						assert.strictEqual(result.messages.length, 3);
						assert.strictEqual(
							result.messages[0].ruleId,
							"no-undef",
						);
						assert.match(result.messages[0].message, /foo_js/u);
						assert.strictEqual(result.messages[0].line, 2);
						assert.strictEqual(
							result.messages[1].ruleId,
							"no-undef",
						);
						assert.match(result.messages[1].message, /foo_cjs/u);
						assert.strictEqual(result.messages[1].line, 10);
						assert.strictEqual(
							result.messages[2].ruleId,
							"no-undef",
						);
						assert.match(result.messages[2].message, /foo_mjs/u);
						assert.strictEqual(result.messages[2].line, 14);
					});
				});
			});

			describe("Patterns which match no file should throw errors.", () => {
				beforeEach(() => {
					eslint = new ESLint({
						flags,
						cwd: getFixturePath("cli-engine"),
						overrideConfigFile: true,
					});
				});

				it("one file", async () => {
					await assert.rejects(async () => {
						await eslint.lintFiles(["non-exist.js"]);
					}, /No files matching 'non-exist\.js' were found\./u);
				});

				it("should throw if the directory exists and is empty", async () => {
					ensureDirectoryExists(getFixturePath("cli-engine/empty"));
					await assert.rejects(async () => {
						await eslint.lintFiles(["empty"]);
					}, /No files matching 'empty' were found\./u);
				});

				it("one glob pattern", async () => {
					await assert.rejects(async () => {
						await eslint.lintFiles(["non-exist/**/*.js"]);
					}, /No files matching 'non-exist\/\*\*\/\*\.js' were found\./u);
				});

				it("two files", async () => {
					await assert.rejects(async () => {
						await eslint.lintFiles(["aaa.js", "bbb.js"]);
					}, /No files matching 'aaa\.js' were found\./u);
				});

				it("a mix of an existing file and a non-existing file", async () => {
					await assert.rejects(async () => {
						await eslint.lintFiles(["console.js", "non-exist.js"]);
					}, /No files matching 'non-exist\.js' were found\./u);
				});

				// https://github.com/eslint/eslint/issues/16275
				it("a mix of an existing glob pattern and a non-existing glob pattern", async () => {
					await assert.rejects(async () => {
						await eslint.lintFiles(["*.js", "non-exist/*.js"]);
					}, /No files matching 'non-exist\/\*\.js' were found\./u);
				});
			});

			describe("multiple processors", () => {
				const root = path.join(
					os.tmpdir(),
					"eslint/eslint/multiple-processors",
				);
				const commonFiles = {
					"node_modules/pattern-processor/index.js": fs.readFileSync(
						require.resolve(
							"../../fixtures/processors/pattern-processor",
						),
						"utf8",
					),
					"node_modules/eslint-plugin-markdown/index.js": `
                        const { defineProcessor } = require("pattern-processor");
                        const processor = defineProcessor(${/```(\w+)\n([\s\S]+?)\n```/gu});
                        exports.processors = {
                            "markdown": { ...processor, supportsAutofix: true },
                            "non-fixable": processor
                        };
                    `,
					"node_modules/eslint-plugin-html/index.js": `
                        const { defineProcessor } = require("pattern-processor");
                        const processor = defineProcessor(${/<script lang="(\w*)">\n([\s\S]+?)\n<\/script>/gu});
                        const legacyProcessor = defineProcessor(${/<script lang="(\w*)">\n([\s\S]+?)\n<\/script>/gu}, true);
                        exports.processors = {
                            "html": { ...processor, supportsAutofix: true },
                            "non-fixable": processor,
                            "legacy": legacyProcessor
                        };
                    `,
					"test.md": unIndent`
                        \`\`\`js
                        console.log("hello")
                        \`\`\`
                        \`\`\`html
                        <div>Hello</div>
                        <script lang="js">
                            console.log("hello")
                        </script>
                        <script lang="ts">
                            console.log("hello")
                        </script>
                        \`\`\`
                    `,
				};

				// unique directory for each test to avoid quirky disk-cleanup errors
				let id;

				beforeEach(() => (id = Date.now().toString()));

				/*
				 * `fs.rmdir(path, { recursive: true })` is deprecated and will be removed.
				 * Use `fs.rm(path, { recursive: true })` instead.
				 * When supporting Node.js 14.14.0+, the compatibility condition can be removed for `fs.rmdir`.
				 */
				if (typeof fsp.rm === "function") {
					afterEach(async () =>
						fsp.rm(root, { recursive: true, force: true }),
					);
				} else {
					afterEach(async () =>
						fsp.rmdir(root, { recursive: true, force: true }),
					);
				}

				it("should lint only JavaScript blocks.", async () => {
					const teardown = createCustomTeardown({
						cwd: path.join(root, id),
						files: {
							...commonFiles,
							"eslint.config.js": `module.exports = [
                                {
                                    plugins: {
                                        markdown: require("eslint-plugin-markdown"),
                                        html: require("eslint-plugin-html")
                                    }
                                },
                                {
                                    files: ["**/*.js"],
                                    rules: { semi: "error" }
                                },
                                {
                                    files: ["**/*.md"],
                                    processor: "markdown/markdown"
                                }
                            ];`,
						},
					});

					await teardown.prepare();
					eslint = new ESLint({ flags, cwd: teardown.getPath() });
					const results = await eslint.lintFiles(["test.md"]);

					assert.strictEqual(
						results.length,
						1,
						"Should have one result.",
					);
					assert.strictEqual(
						results[0].messages.length,
						1,
						"Should have one message.",
					);
					assert.strictEqual(results[0].messages[0].ruleId, "semi");
					assert.strictEqual(
						results[0].messages[0].line,
						2,
						"Message should be on line 2.",
					);
					assert.strictEqual(results[0].suppressedMessages.length, 0);
				});

				it("should lint HTML blocks as well with multiple processors if represented in config.", async () => {
					const teardown = createCustomTeardown({
						cwd: path.join(root, id),
						files: {
							...commonFiles,
							"eslint.config.js": `module.exports = [
                                {
                                    plugins: {
                                        markdown: require("eslint-plugin-markdown"),
                                        html: require("eslint-plugin-html")
                                    }
                                },
                                {
                                    files: ["**/*.js"],
                                    rules: { semi: "error" }
                                },
                                {
                                    files: ["**/*.md"],
                                    processor: "markdown/markdown"
                                },
                                {
                                    files: ["**/*.html"],
                                    processor: "html/html"
                                }
                            ];`,
						},
					});

					await teardown.prepare();
					eslint = new ESLint({
						flags,
						cwd: teardown.getPath(),
						overrideConfig: { files: ["**/*.html"] },
					});
					const results = await eslint.lintFiles(["test.md"]);

					assert.strictEqual(
						results.length,
						1,
						"Should have one result.",
					);
					assert.strictEqual(
						results[0].messages.length,
						2,
						"Should have two messages.",
					);
					assert.strictEqual(results[0].messages[0].ruleId, "semi"); // JS block
					assert.strictEqual(
						results[0].messages[0].line,
						2,
						"First error should be on line 2",
					);
					assert.strictEqual(results[0].messages[1].ruleId, "semi"); // JS block in HTML block
					assert.strictEqual(
						results[0].messages[1].line,
						7,
						"Second error should be on line 7.",
					);
					assert.strictEqual(results[0].suppressedMessages.length, 0);
				});

				it("should fix HTML blocks as well with multiple processors if represented in config.", async () => {
					const teardown = createCustomTeardown({
						cwd: path.join(root, id),
						files: {
							...commonFiles,
							"eslint.config.js": `module.exports = [
                                {
                                    plugins: {
                                        markdown: require("eslint-plugin-markdown"),
                                        html: require("eslint-plugin-html")
                                    }
                                },
                                {
                                    files: ["**/*.js"],
                                    rules: { semi: "error" }
                                },
                                {
                                    files: ["**/*.md"],
                                    processor: "markdown/markdown"
                                },
                                {
                                    files: ["**/*.html"],
                                    processor: "html/html"
                                }
                            ];`,
						},
					});

					await teardown.prepare();
					eslint = new ESLint({
						flags,
						cwd: teardown.getPath(),
						overrideConfig: { files: ["**/*.html"] },
						fix: true,
					});
					const results = await eslint.lintFiles(["test.md"]);

					assert.strictEqual(results.length, 1);
					assert.strictEqual(results[0].messages.length, 0);
					assert.strictEqual(results[0].suppressedMessages.length, 0);
					assert.strictEqual(
						results[0].output,
						unIndent`
                        \`\`\`js
                        console.log("hello");${/* ← fixed */ ""}
                        \`\`\`
                        \`\`\`html
                        <div>Hello</div>
                        <script lang="js">
                            console.log("hello");${/* ← fixed */ ""}
                        </script>
                        <script lang="ts">
                            console.log("hello")${/* ← ignored */ ""}
                        </script>
                        \`\`\`
                    `,
					);
				});

				it("should use the config '**/*.html/*.js' to lint JavaScript blocks in HTML.", async () => {
					const teardown = createCustomTeardown({
						cwd: path.join(root, id),
						files: {
							...commonFiles,
							"eslint.config.js": `module.exports = [
                                {
                                    plugins: {
                                        markdown: require("eslint-plugin-markdown"),
                                        html: require("eslint-plugin-html")
                                    }
                                },
                                {
                                    files: ["**/*.js"],
                                    rules: { semi: "error" }
                                },
                                {
                                    files: ["**/*.md"],
                                    processor: "markdown/markdown"
                                },
                                {
                                    files: ["**/*.html"],
                                    processor: "html/html"
                                },
                                {
                                    files: ["**/*.html/*.js"],
                                    rules: {
                                        semi: "off",
                                        "no-console": "error"
                                    }
                                }

                            ];`,
						},
					});

					await teardown.prepare();
					eslint = new ESLint({
						flags,
						cwd: teardown.getPath(),
						overrideConfig: { files: ["**/*.html"] },
					});
					const results = await eslint.lintFiles(["test.md"]);

					assert.strictEqual(results.length, 1);
					assert.strictEqual(results[0].messages.length, 2);
					assert.strictEqual(results[0].messages[0].ruleId, "semi");
					assert.strictEqual(results[0].messages[0].line, 2);
					assert.strictEqual(
						results[0].messages[1].ruleId,
						"no-console",
					);
					assert.strictEqual(results[0].messages[1].line, 7);
					assert.strictEqual(results[0].suppressedMessages.length, 0);
				});

				it("should use the same config as one which has 'processor' property in order to lint blocks in HTML if the processor was legacy style.", async () => {
					const teardown = createCustomTeardown({
						cwd: path.join(root, id),
						files: {
							...commonFiles,
							"eslint.config.js": `module.exports = [
                                {
                                    plugins: {
                                        markdown: require("eslint-plugin-markdown"),
                                        html: require("eslint-plugin-html")
                                    },
                                    rules: { semi: "error" }
                                },
                                {
                                    files: ["**/*.md"],
                                    processor: "markdown/markdown"
                                },
                                {
                                    files: ["**/*.html"],
                                    processor: "html/legacy",  // this processor returns strings rather than '{ text, filename }'
                                    rules: {
                                        semi: "off",
                                        "no-console": "error"
                                    }
                                },
                                {
                                    files: ["**/*.html/*.js"],
                                    rules: {
                                        semi: "error",
                                        "no-console": "off"
                                    }
                                }

                            ];`,
						},
					});

					await teardown.prepare();
					eslint = new ESLint({
						flags,
						cwd: teardown.getPath(),
						overrideConfig: { files: ["**/*.html"] },
					});
					const results = await eslint.lintFiles(["test.md"]);

					assert.strictEqual(results.length, 1);
					assert.strictEqual(results[0].messages.length, 3);
					assert.strictEqual(results[0].messages[0].ruleId, "semi");
					assert.strictEqual(results[0].messages[0].line, 2);
					assert.strictEqual(
						results[0].messages[1].ruleId,
						"no-console",
					);
					assert.strictEqual(results[0].messages[1].line, 7);
					assert.strictEqual(
						results[0].messages[2].ruleId,
						"no-console",
					);
					assert.strictEqual(results[0].messages[2].line, 10);
					assert.strictEqual(results[0].suppressedMessages.length, 0);
				});

				it("should throw an error if invalid processor was specified.", async () => {
					const teardown = createCustomTeardown({
						cwd: path.join(root, id),
						files: {
							...commonFiles,
							"eslint.config.js": `module.exports = [
                                {
                                    plugins: {
                                        markdown: require("eslint-plugin-markdown"),
                                        html: require("eslint-plugin-html")
                                    }
                                },
                                {
                                    files: ["**/*.md"],
                                    processor: "markdown/unknown"
                                }

                            ];`,
						},
					});

					await teardown.prepare();
					eslint = new ESLint({ flags, cwd: teardown.getPath() });

					await assert.rejects(async () => {
						await eslint.lintFiles(["test.md"]);
					}, /Key "processor": Could not find "unknown" in plugin "markdown"/u);
				});
			});

			describe("glob pattern '[ab].js'", () => {
				const root = getFixturePath("cli-engine/unmatched-glob");

				let cleanup;

				beforeEach(() => {
					cleanup = () => {};
				});

				afterEach(() => cleanup());

				it("should match '[ab].js' if existed.", async () => {
					const teardown = createCustomTeardown({
						cwd: root,
						files: {
							"a.js": "",
							"b.js": "",
							"ab.js": "",
							"[ab].js": "",
							"eslint.config.js": "module.exports = [{}];",
						},
					});

					await teardown.prepare();
					cleanup = teardown.cleanup;

					eslint = new ESLint({ flags, cwd: teardown.getPath() });
					const results = await eslint.lintFiles(["[ab].js"]);
					const filenames = results.map(r =>
						path.basename(r.filePath),
					);

					assert.deepStrictEqual(filenames, ["[ab].js"]);
				});

				it("should match 'a.js' and 'b.js' if '[ab].js' didn't existed.", async () => {
					const teardown = createCustomTeardown({
						cwd: root,
						files: {
							"a.js": "",
							"b.js": "",
							"ab.js": "",
							"eslint.config.js": "module.exports = [{}];",
						},
					});

					await teardown.prepare();
					cleanup = teardown.cleanup;
					eslint = new ESLint({ flags, cwd: teardown.getPath() });
					const results = await eslint.lintFiles(["[ab].js"]);
					const filenames = results.map(r =>
						path.basename(r.filePath),
					);

					assert.deepStrictEqual(filenames, ["a.js", "b.js"]);
				});
			});

			describe("with 'noInlineConfig' setting", () => {
				const root = getFixturePath("cli-engine/noInlineConfig");

				let cleanup;

				beforeEach(() => {
					cleanup = () => {};
				});

				afterEach(() => cleanup());

				it("should warn directive comments if 'noInlineConfig' was given.", async () => {
					const teardown = createCustomTeardown({
						cwd: root,
						files: {
							"test.js": "/* globals foo */",
							"eslint.config.js":
								"module.exports = [{ linterOptions: { noInlineConfig: true } }];",
						},
					});

					await teardown.prepare();
					cleanup = teardown.cleanup;
					eslint = new ESLint({ flags, cwd: teardown.getPath() });

					const results = await eslint.lintFiles(["test.js"]);
					const messages = results[0].messages;

					assert.strictEqual(messages.length, 1);
					assert.strictEqual(
						messages[0].message,
						"'/* globals foo */' has no effect because you have 'noInlineConfig' setting in your config.",
					);
				});
			});

			describe("with 'reportUnusedDisableDirectives' setting", () => {
				const root = getFixturePath(
					"cli-engine/reportUnusedDisableDirectives",
				);

				let cleanup;
				let i = 0;

				beforeEach(() => {
					cleanup = () => {};
					i++;
				});

				afterEach(() => cleanup());

				it("should error unused 'eslint-disable' comments if 'reportUnusedDisableDirectives = error'.", async () => {
					const teardown = createCustomTeardown({
						cwd: `${root}${i}`,
						files: {
							"test.js": "/* eslint-disable eqeqeq */",
							"eslint.config.js":
								"module.exports = { linterOptions: { reportUnusedDisableDirectives: 'error' } }",
						},
					});

					await teardown.prepare();
					cleanup = teardown.cleanup;
					eslint = new ESLint({ flags, cwd: teardown.getPath() });

					const results = await eslint.lintFiles(["test.js"]);
					const messages = results[0].messages;

					assert.strictEqual(messages.length, 1);
					assert.strictEqual(messages[0].severity, 2);
					assert.strictEqual(
						messages[0].message,
						"Unused eslint-disable directive (no problems were reported from 'eqeqeq').",
					);
					assert.strictEqual(results[0].suppressedMessages.length, 0);
				});

				it("should error unused 'eslint-disable' comments if 'reportUnusedDisableDirectives = 2'.", async () => {
					const teardown = createCustomTeardown({
						cwd: `${root}${i}`,
						files: {
							"test.js": "/* eslint-disable eqeqeq */",
							"eslint.config.js":
								"module.exports = { linterOptions: { reportUnusedDisableDirectives: 2 } }",
						},
					});

					await teardown.prepare();
					cleanup = teardown.cleanup;
					eslint = new ESLint({ flags, cwd: teardown.getPath() });

					const results = await eslint.lintFiles(["test.js"]);
					const messages = results[0].messages;

					assert.strictEqual(messages.length, 1);
					assert.strictEqual(messages[0].severity, 2);
					assert.strictEqual(
						messages[0].message,
						"Unused eslint-disable directive (no problems were reported from 'eqeqeq').",
					);
					assert.strictEqual(results[0].suppressedMessages.length, 0);
				});

				it("should warn unused 'eslint-disable' comments if 'reportUnusedDisableDirectives = warn'.", async () => {
					const teardown = createCustomTeardown({
						cwd: `${root}${i}`,
						files: {
							"test.js": "/* eslint-disable eqeqeq */",
							"eslint.config.js":
								"module.exports = { linterOptions: { reportUnusedDisableDirectives: 'warn' } }",
						},
					});

					await teardown.prepare();
					cleanup = teardown.cleanup;
					eslint = new ESLint({ flags, cwd: teardown.getPath() });

					const results = await eslint.lintFiles(["test.js"]);
					const messages = results[0].messages;

					assert.strictEqual(messages.length, 1);
					assert.strictEqual(messages[0].severity, 1);
					assert.strictEqual(
						messages[0].message,
						"Unused eslint-disable directive (no problems were reported from 'eqeqeq').",
					);
					assert.strictEqual(results[0].suppressedMessages.length, 0);
				});

				it("should warn unused 'eslint-disable' comments if 'reportUnusedDisableDirectives = 1'.", async () => {
					const teardown = createCustomTeardown({
						cwd: `${root}${i}`,
						files: {
							"test.js": "/* eslint-disable eqeqeq */",
							"eslint.config.js":
								"module.exports = { linterOptions: { reportUnusedDisableDirectives: 1 } }",
						},
					});

					await teardown.prepare();
					cleanup = teardown.cleanup;
					eslint = new ESLint({ flags, cwd: teardown.getPath() });

					const results = await eslint.lintFiles(["test.js"]);
					const messages = results[0].messages;

					assert.strictEqual(messages.length, 1);
					assert.strictEqual(messages[0].severity, 1);
					assert.strictEqual(
						messages[0].message,
						"Unused eslint-disable directive (no problems were reported from 'eqeqeq').",
					);
					assert.strictEqual(results[0].suppressedMessages.length, 0);
				});

				it("should warn unused 'eslint-disable' comments if 'reportUnusedDisableDirectives = true'.", async () => {
					const teardown = createCustomTeardown({
						cwd: `${root}${i}`,
						files: {
							"test.js": "/* eslint-disable eqeqeq */",
							"eslint.config.js":
								"module.exports = { linterOptions: { reportUnusedDisableDirectives: true } }",
						},
					});

					await teardown.prepare();
					cleanup = teardown.cleanup;
					eslint = new ESLint({ flags, cwd: teardown.getPath() });

					const results = await eslint.lintFiles(["test.js"]);
					const messages = results[0].messages;

					assert.strictEqual(messages.length, 1);
					assert.strictEqual(messages[0].severity, 1);
					assert.strictEqual(
						messages[0].message,
						"Unused eslint-disable directive (no problems were reported from 'eqeqeq').",
					);
					assert.strictEqual(results[0].suppressedMessages.length, 0);
				});

				it("should not warn unused 'eslint-disable' comments if 'reportUnusedDisableDirectives = false'.", async () => {
					const teardown = createCustomTeardown({
						cwd: `${root}${i}`,
						files: {
							"test.js": "/* eslint-disable eqeqeq */",
							"eslint.config.js":
								"module.exports = { linterOptions: { reportUnusedDisableDirectives: false } }",
						},
					});

					await teardown.prepare();
					cleanup = teardown.cleanup;
					eslint = new ESLint({ flags, cwd: teardown.getPath() });

					const results = await eslint.lintFiles(["test.js"]);
					const messages = results[0].messages;

					assert.strictEqual(messages.length, 0);
				});

				it("should not warn unused 'eslint-disable' comments if 'reportUnusedDisableDirectives = off'.", async () => {
					const teardown = createCustomTeardown({
						cwd: `${root}${i}`,
						files: {
							"test.js": "/* eslint-disable eqeqeq */",
							"eslint.config.js":
								"module.exports = { linterOptions: { reportUnusedDisableDirectives: 'off' } }",
						},
					});

					await teardown.prepare();
					cleanup = teardown.cleanup;
					eslint = new ESLint({ flags, cwd: teardown.getPath() });

					const results = await eslint.lintFiles(["test.js"]);
					const messages = results[0].messages;

					assert.strictEqual(messages.length, 0);
				});

				it("should not warn unused 'eslint-disable' comments if 'reportUnusedDisableDirectives = 0'.", async () => {
					const teardown = createCustomTeardown({
						cwd: `${root}${i}`,
						files: {
							"test.js": "/* eslint-disable eqeqeq */",
							"eslint.config.js":
								"module.exports = { linterOptions: { reportUnusedDisableDirectives: 0 } }",
						},
					});

					await teardown.prepare();
					cleanup = teardown.cleanup;
					eslint = new ESLint({ flags, cwd: teardown.getPath() });

					const results = await eslint.lintFiles(["test.js"]);
					const messages = results[0].messages;

					assert.strictEqual(messages.length, 0);
				});

				describe("the runtime option overrides config files.", () => {
					it("should not warn unused 'eslint-disable' comments if 'reportUnusedDisableDirectives=off' was given in runtime.", async () => {
						const teardown = createCustomTeardown({
							cwd: `${root}${i}`,
							files: {
								"test.js": "/* eslint-disable eqeqeq */",
								"eslint.config.js":
									"module.exports = [{ linterOptions: { reportUnusedDisableDirectives: true } }]",
							},
						});

						await teardown.prepare();
						cleanup = teardown.cleanup;

						eslint = new ESLint({
							flags,
							cwd: teardown.getPath(),
							overrideConfig: {
								linterOptions: {
									reportUnusedDisableDirectives: "off",
								},
							},
						});

						const results = await eslint.lintFiles(["test.js"]);
						const messages = results[0].messages;

						assert.strictEqual(messages.length, 0);
					});

					it("should warn unused 'eslint-disable' comments as error if 'reportUnusedDisableDirectives=error' was given in runtime.", async () => {
						const teardown = createCustomTeardown({
							cwd: `${root}${i}`,
							files: {
								"test.js": "/* eslint-disable eqeqeq */",
								"eslint.config.js":
									"module.exports = [{ linterOptions: { reportUnusedDisableDirectives: true } }]",
							},
						});

						await teardown.prepare();
						cleanup = teardown.cleanup;

						eslint = new ESLint({
							flags,
							cwd: teardown.getPath(),
							overrideConfig: {
								linterOptions: {
									reportUnusedDisableDirectives: "error",
								},
							},
						});

						const results = await eslint.lintFiles(["test.js"]);
						const messages = results[0].messages;

						assert.strictEqual(messages.length, 1);
						assert.strictEqual(messages[0].severity, 2);
						assert.strictEqual(
							messages[0].message,
							"Unused eslint-disable directive (no problems were reported from 'eqeqeq').",
						);
						assert.strictEqual(
							results[0].suppressedMessages.length,
							0,
						);
					});
				});
			});

			it("should throw if an invalid value is given to 'patterns' argument", async () => {
				eslint = new ESLint({ flags });
				await assert.rejects(
					() => eslint.lintFiles(777),
					/'patterns' must be a non-empty string or an array of non-empty strings/u,
				);
				await assert.rejects(
					() => eslint.lintFiles([null]),
					/'patterns' must be a non-empty string or an array of non-empty strings/u,
				);
			});

			describe("Alternate config files", () => {
				it("should find eslint.config.mjs when present", async () => {
					const cwd = getFixturePath("mjs-config");

					eslint = new ESLint({
						flags,
						cwd,
					});

					const results = await eslint.lintFiles("foo.js");

					assert.strictEqual(results.length, 1);
					assert.strictEqual(results[0].messages.length, 1);
					assert.strictEqual(results[0].messages[0].severity, 2);
					assert.strictEqual(
						results[0].messages[0].ruleId,
						"no-undef",
					);
				});

				it("should find eslint.config.cjs when present", async () => {
					const cwd = getFixturePath("cjs-config");

					eslint = new ESLint({
						flags,
						cwd,
					});

					const results = await eslint.lintFiles("foo.js");

					assert.strictEqual(results.length, 1);
					assert.strictEqual(results[0].messages.length, 1);
					assert.strictEqual(results[0].messages[0].severity, 1);
					assert.strictEqual(
						results[0].messages[0].ruleId,
						"no-undef",
					);
				});

				it("should favor eslint.config.js when eslint.config.mjs and eslint.config.cjs are present", async () => {
					const cwd = getFixturePath("js-mjs-cjs-config");

					eslint = new ESLint({
						flags,
						cwd,
					});

					const results = await eslint.lintFiles("foo.js");

					assert.strictEqual(results.length, 1);
					assert.strictEqual(results[0].messages.length, 0);
				});

				it("should favor eslint.config.mjs when eslint.config.cjs is present", async () => {
					const cwd = getFixturePath("mjs-cjs-config");

					eslint = new ESLint({
						flags,
						cwd,
					});

					const results = await eslint.lintFiles("foo.js");

					assert.strictEqual(results.length, 1);
					assert.strictEqual(results[0].messages.length, 1);
					assert.strictEqual(results[0].messages[0].severity, 2);
					assert.strictEqual(
						results[0].messages[0].ruleId,
						"no-undef",
					);
				});
			});

			describe("TypeScript config files", () => {
				const typeModule = JSON.stringify({ type: "module" }, null, 2);

				const typeCommonJS = JSON.stringify(
					{ type: "commonjs" },
					null,
					2,
				);

				JITI_VERSIONS.forEach(jitiVersion => {
					describe(`Loading TypeScript config files with ${jitiVersion}`, () => {
						if (jitiVersion !== "jiti") {
							beforeEach(() => {
								sinon
									.stub(ConfigLoader, "loadJiti")
									.callsFake(() =>
										Promise.resolve({
											createJiti:
												require(jitiVersion).createJiti,
											version: require(
												`${jitiVersion}/package.json`,
											).version,
										}),
									);
							});
						}

						it("should find and load eslint.config.ts when present", async () => {
							const cwd = getFixturePath("ts-config-files", "ts");

							eslint = new ESLint({
								cwd,
								flags,
							});

							const results = await eslint.lintFiles("foo.js");

							assert.strictEqual(
								await eslint.findConfigFile(),
								path.join(cwd, "eslint.config.ts"),
							);
							assert.strictEqual(results.length, 1);
							assert.strictEqual(results[0].messages.length, 1);
							assert.strictEqual(
								results[0].messages[0].severity,
								2,
							);
							assert.strictEqual(
								results[0].messages[0].ruleId,
								"no-undef",
							);
						});

						it('should load eslint.config.ts when we have "type": "commonjs" in nearest `package.json`', async () => {
							const cwd = getFixturePath(
								"ts-config-files",
								"ts",
								"with-type-commonjs",
							);

							eslint = new ESLint({
								cwd,
								flags,
							});

							const results = await eslint.lintFiles("foo.js");

							assert.strictEqual(
								await eslint.findConfigFile(),
								path.join(cwd, "eslint.config.ts"),
							);
							assert.strictEqual(results.length, 1);
							assert.strictEqual(results[0].messages.length, 1);
							assert.strictEqual(
								results[0].messages[0].severity,
								2,
							);
							assert.strictEqual(
								results[0].messages[0].ruleId,
								"no-undef",
							);
						});

						it('should load eslint.config.ts when we have "type": "module" in nearest `package.json`', async () => {
							const cwd = getFixturePath(
								"ts-config-files",
								"ts",
								"with-type-module",
							);

							eslint = new ESLint({
								cwd,
								flags,
							});

							const results = await eslint.lintFiles("foo.js");

							assert.strictEqual(
								await eslint.findConfigFile(),
								path.join(cwd, "eslint.config.ts"),
							);
							assert.strictEqual(results.length, 1);
							assert.strictEqual(results[0].messages.length, 1);
							assert.strictEqual(
								results[0].messages[0].severity,
								2,
							);
							assert.strictEqual(
								results[0].messages[0].ruleId,
								"no-undef",
							);
						});

						it('should load eslint.config.ts with ESM syntax and "type": "commonjs" in nearest `package.json`', async () => {
							const cwd = getFixturePath(
								"ts-config-files",
								"ts",
								"with-type-commonjs",
								"ESM-syntax",
							);

							const configFileContent = `import type { FlatConfig } from "../../../helper";\nexport default ${JSON.stringify(
								[{ rules: { "no-undef": 2 } }],
								null,
								2,
							)} satisfies FlatConfig[];`;

							const teardown = createCustomTeardown({
								cwd,
								files: {
									"package.json": typeCommonJS,
									"eslint.config.ts": configFileContent,
									"foo.js": "foo;",
								},
							});

							await teardown.prepare();

							eslint = new ESLint({
								cwd,
								flags,
							});

							const results = await eslint.lintFiles(["foo.js"]);

							assert.strictEqual(
								await eslint.findConfigFile(),
								path.join(cwd, "eslint.config.ts"),
							);
							assert.strictEqual(results.length, 1);
							assert.strictEqual(results[0].messages.length, 1);
							assert.strictEqual(
								results[0].messages[0].severity,
								2,
							);
							assert.strictEqual(
								results[0].messages[0].ruleId,
								"no-undef",
							);
						});

						it('should load eslint.config.ts with CJS syntax and "type": "module" in nearest `package.json`', async () => {
							const cwd = getFixturePath(
								"ts-config-files",
								"ts",
								"with-type-module",
								"CJS-syntax",
							);

							const configFileContent = `import type { FlatConfig } from "../../../helper";\nmodule.exports = ${JSON.stringify(
								[{ rules: { "no-undef": 2 } }],
								null,
								2,
							)} satisfies FlatConfig[];`;

							const teardown = createCustomTeardown({
								cwd,
								files: {
									"package.json": typeModule,
									"eslint.config.ts": configFileContent,
									"foo.js": "foo;",
								},
							});

							await teardown.prepare();

							eslint = new ESLint({
								cwd,
								flags,
							});

							const results = await eslint.lintFiles(["foo.js"]);

							assert.strictEqual(
								await eslint.findConfigFile(),
								path.join(cwd, "eslint.config.ts"),
							);
							assert.strictEqual(results.length, 1);
							assert.strictEqual(results[0].messages.length, 1);
							assert.strictEqual(
								results[0].messages[0].severity,
								2,
							);
							assert.strictEqual(
								results[0].messages[0].ruleId,
								"no-undef",
							);
						});

						it('should load eslint.config.ts with CJS syntax and "type": "commonjs" in nearest `package.json`', async () => {
							const cwd = getFixturePath(
								"ts-config-files",
								"ts",
								"with-type-commonjs",
								"CJS-syntax",
							);

							const configFileContent = `import type { FlatConfig } from "../../../helper";\nmodule.exports = ${JSON.stringify(
								[{ rules: { "no-undef": 2 } }],
								null,
								2,
							)} satisfies FlatConfig[];`;

							const teardown = createCustomTeardown({
								cwd,
								files: {
									"package.json": typeCommonJS,
									"eslint.config.ts": configFileContent,
									"foo.js": "foo;",
								},
							});

							await teardown.prepare();

							eslint = new ESLint({
								cwd,
								flags,
							});

							const results = await eslint.lintFiles(["foo.js"]);

							assert.strictEqual(
								await eslint.findConfigFile(),
								path.join(cwd, "eslint.config.ts"),
							);
							assert.strictEqual(results.length, 1);
							assert.strictEqual(results[0].messages.length, 1);
							assert.strictEqual(
								results[0].messages[0].severity,
								2,
							);
							assert.strictEqual(
								results[0].messages[0].ruleId,
								"no-undef",
							);
						});

						it('should load eslint.config.ts with CJS syntax, "type": "module" in nearest `package.json` and top-level await syntax', async () => {
							const cwd = getFixturePath(
								"ts-config-files",
								"ts",
								"with-type-module",
								"CJS-syntax",
								"top-level-await",
							);

							const configFileContent = `import type { FlatConfig } from "../../../../helper";\nmodule.exports = await Promise.resolve(${JSON.stringify(
								[{ rules: { "no-undef": 2 } }],
								null,
								2,
							)}) satisfies FlatConfig[];`;

							const teardown = createCustomTeardown({
								cwd,
								files: {
									"package.json": typeModule,
									"eslint.config.ts": configFileContent,
									"foo.js": "foo;",
								},
							});

							await teardown.prepare();

							eslint = new ESLint({
								cwd,
								flags,
							});

							const results = await eslint.lintFiles(["foo.js"]);

							assert.strictEqual(
								await eslint.findConfigFile(),
								path.join(cwd, "eslint.config.ts"),
							);
							assert.strictEqual(results.length, 1);
							assert.strictEqual(results[0].messages.length, 1);
							assert.strictEqual(
								results[0].messages[0].severity,
								2,
							);
							assert.strictEqual(
								results[0].messages[0].ruleId,
								"no-undef",
							);
						});

						it('should load eslint.config.ts with CJS syntax, "type": "commonjs" in nearest `package.json` and top-level await syntax', async () => {
							const cwd = getFixturePath(
								"ts-config-files",
								"ts",
								"with-type-commonjs",
								"CJS-syntax",
								"top-level-await",
							);

							const configFileContent = `import type { FlatConfig } from "../../../../helper";\nmodule.exports = await Promise.resolve(${JSON.stringify(
								[{ rules: { "no-undef": 2 } }],
								null,
								2,
							)}) satisfies FlatConfig[];`;

							const teardown = createCustomTeardown({
								cwd,
								files: {
									"package.json": typeCommonJS,
									"eslint.config.ts": configFileContent,
									"foo.js": "foo;",
								},
							});

							await teardown.prepare();

							eslint = new ESLint({
								cwd,
								flags,
							});

							const results = await eslint.lintFiles(["foo.js"]);

							assert.strictEqual(
								await eslint.findConfigFile(),
								path.join(cwd, "eslint.config.ts"),
							);
							assert.strictEqual(results.length, 1);
							assert.strictEqual(results[0].messages.length, 1);
							assert.strictEqual(
								results[0].messages[0].severity,
								2,
							);
							assert.strictEqual(
								results[0].messages[0].ruleId,
								"no-undef",
							);
						});

						it('should load eslint.config.ts with CJS syntax, "type": "module" in nearest `package.json` and top-level await syntax (named import)', async () => {
							const cwd = getFixturePath(
								"ts-config-files",
								"ts",
								"with-type-module",
								"top-level-await",
								"named-import",
							);

							const configFileContent =
								'import type { FlatConfig } from "../../../../helper";\nconst { rules } = await import("./rules");\nmodule.exports = [{ rules }] satisfies FlatConfig[];';

							const teardown = createCustomTeardown({
								cwd,
								files: {
									"rules.ts": `export const rules = ${JSON.stringify(
										{
											"no-undef": 2,
										},
										null,
										2,
									)};`,
									"package.json": typeModule,
									"eslint.config.ts": configFileContent,
									"foo.js": "foo;",
								},
							});

							await teardown.prepare();

							eslint = new ESLint({
								cwd,
								flags,
							});

							const results = await eslint.lintFiles(["foo.js"]);

							assert.strictEqual(
								await eslint.findConfigFile(),
								path.join(cwd, "eslint.config.ts"),
							);
							assert.strictEqual(results.length, 1);
							assert.strictEqual(results[0].messages.length, 1);
							assert.strictEqual(
								results[0].messages[0].severity,
								2,
							);
							assert.strictEqual(
								results[0].messages[0].ruleId,
								"no-undef",
							);
						});

						it('should load eslint.config.ts with CJS syntax, "type": "commonjs" in nearest `package.json` and top-level await syntax (named import)', async () => {
							const cwd = getFixturePath(
								"ts-config-files",
								"ts",
								"with-type-commonjs",
								"top-level-await",
								"named-import",
							);

							const configFileContent =
								'import type { FlatConfig } from "../../../../helper";\nconst { rules } = await import("./rules");\nmodule.exports = [{ rules }] satisfies FlatConfig[];';

							const teardown = createCustomTeardown({
								cwd,
								files: {
									"rules.ts": `export const rules = ${JSON.stringify(
										{
											"no-undef": 2,
										},
										null,
										2,
									)};`,
									"package.json": typeCommonJS,
									"eslint.config.ts": configFileContent,
									"foo.js": "foo;",
								},
							});

							await teardown.prepare();

							eslint = new ESLint({
								cwd,
								flags,
							});

							const results = await eslint.lintFiles(["foo.js"]);

							assert.strictEqual(
								await eslint.findConfigFile(),
								path.join(cwd, "eslint.config.ts"),
							);
							assert.strictEqual(results.length, 1);
							assert.strictEqual(results[0].messages.length, 1);
							assert.strictEqual(
								results[0].messages[0].severity,
								2,
							);
							assert.strictEqual(
								results[0].messages[0].ruleId,
								"no-undef",
							);
						});

						it('should load eslint.config.ts with CJS syntax, "type": "module" in nearest `package.json` and top-level await syntax (import default)', async () => {
							const cwd = getFixturePath(
								"ts-config-files",
								"ts",
								"with-type-module",
								"top-level-await",
								"import-default",
							);

							const configFileContent =
								'import type { FlatConfig } from "../../../../helper";\nconst { default: rules } = await import("./rules");\nmodule.exports = [{ rules }] satisfies FlatConfig[];';

							const teardown = createCustomTeardown({
								cwd,
								files: {
									"rules.ts": `export default ${JSON.stringify(
										{
											"no-undef": 2,
										},
										null,
										2,
									)};`,
									"package.json": typeModule,
									"eslint.config.ts": configFileContent,
									"foo.js": "foo;",
								},
							});

							await teardown.prepare();

							eslint = new ESLint({
								cwd,
								flags,
							});

							const results = await eslint.lintFiles(["foo.js"]);

							assert.strictEqual(
								await eslint.findConfigFile(),
								path.join(cwd, "eslint.config.ts"),
							);
							assert.strictEqual(results.length, 1);
							assert.strictEqual(results[0].messages.length, 1);
							assert.strictEqual(
								results[0].messages[0].severity,
								2,
							);
							assert.strictEqual(
								results[0].messages[0].ruleId,
								"no-undef",
							);
						});

						it('should load eslint.config.ts with CJS syntax, "type": "commonjs" in nearest `package.json` and top-level await syntax (import default)', async () => {
							const cwd = getFixturePath(
								"ts-config-files",
								"ts",
								"with-type-commonjs",
								"top-level-await",
								"import-default",
							);

							const configFileContent =
								'import type { FlatConfig } from "../../../../helper";\nconst { default: rules } = await import("./rules");\nmodule.exports = [{ rules }] satisfies FlatConfig[];';

							const teardown = createCustomTeardown({
								cwd,
								files: {
									"rules.ts": `export default ${JSON.stringify(
										{
											"no-undef": 2,
										},
										null,
										2,
									)};`,
									"package.json": typeCommonJS,
									"eslint.config.ts": configFileContent,
									"foo.js": "foo;",
								},
							});

							await teardown.prepare();

							eslint = new ESLint({
								cwd,
								flags,
							});

							const results = await eslint.lintFiles(["foo.js"]);

							assert.strictEqual(
								await eslint.findConfigFile(),
								path.join(cwd, "eslint.config.ts"),
							);
							assert.strictEqual(results.length, 1);
							assert.strictEqual(results[0].messages.length, 1);
							assert.strictEqual(
								results[0].messages[0].severity,
								2,
							);
							assert.strictEqual(
								results[0].messages[0].ruleId,
								"no-undef",
							);
						});

						it('should load eslint.config.ts with CJS syntax, "type": "module" in nearest `package.json` and top-level await syntax (default and named imports)', async () => {
							const cwd = getFixturePath(
								"ts-config-files",
								"ts",
								"with-type-module",
								"top-level-await",
								"import-default-and-named",
							);

							const configFileContent =
								'import type { FlatConfig } from "../../../../helper";\nconst { default: rules, Level } = await import("./rules");\n\nmodule.exports = [{ rules: { ...rules, semi: Level.Error } }] satisfies FlatConfig[];';

							const teardown = createCustomTeardown({
								cwd,
								files: {
									"rules.ts": `import type { RulesRecord } from "../../../../helper";\nexport const enum Level {\nError = 2,\nWarn = 1,\nOff = 0,\n};\nexport default ${JSON.stringify(
										{
											"no-undef": 2,
										},
										null,
										2,
									)} satisfies RulesRecord;`,
									"package.json": typeModule,
									"eslint.config.ts": configFileContent,
									"foo.js": "foo",
								},
							});

							await teardown.prepare();

							eslint = new ESLint({
								cwd,
								flags,
							});

							const results = await eslint.lintFiles(["foo.js"]);

							assert.strictEqual(
								await eslint.findConfigFile(),
								path.join(cwd, "eslint.config.ts"),
							);
							assert.strictEqual(results.length, 1);
							assert.strictEqual(results[0].messages.length, 2);
							assert.strictEqual(
								results[0].messages[0].severity,
								2,
							);
							assert.strictEqual(
								results[0].messages[1].severity,
								2,
							);
							assert.strictEqual(
								results[0].messages[0].ruleId,
								"no-undef",
							);
						});

						it('should load eslint.config.ts with TypeScript\'s CJS syntax (import and export assignment), "type": "module" in nearest `package.json`', async () => {
							const cwd = getFixturePath(
								"ts-config-files",
								"ts",
								"with-type-module",
								"import-and-export-assignment",
							);

							const configFileContent =
								'import type { FlatConfig } from "../../../helper";\nimport rulesModule = require("./rules");\nconst { rules, Level } = rulesModule;\nexport = [{ rules: { ...rules, semi: Level.Error } }] satisfies FlatConfig[];';

							const teardown = createCustomTeardown({
								cwd,
								files: {
									"rules.ts":
										'import type { RulesRecord } from "../../../helper";\nimport { Severity } from "../../../helper";\nconst enum Level {\nError = 2,\nWarn = 1,\nOff = 0,\n};\nexport = { rules: { "no-undef": Severity.Error }, Level } satisfies RulesRecord;',
									"package.json": typeModule,
									"eslint.config.ts": configFileContent,
									"foo.js": "foo",
								},
							});

							await teardown.prepare();

							eslint = new ESLint({
								cwd,
								flags,
							});

							const results = await eslint.lintFiles(["foo.js"]);

							assert.strictEqual(
								await eslint.findConfigFile(),
								path.join(cwd, "eslint.config.ts"),
							);
							assert.strictEqual(results.length, 1);
							assert.strictEqual(results[0].messages.length, 2);
							assert.strictEqual(
								results[0].messages[0].severity,
								2,
							);
							assert.strictEqual(
								results[0].messages[1].severity,
								2,
							);
							assert.strictEqual(
								results[0].messages[0].ruleId,
								"no-undef",
							);
						});

						it('should load eslint.config.ts with TypeScript\'s CJS syntax (import and export assignment), "type": "commonjs" in nearest `package.json`', async () => {
							const cwd = getFixturePath(
								"ts-config-files",
								"ts",
								"with-type-commonjs",
								"import-and-export-assignment",
							);

							const configFileContent =
								'import type { FlatConfig } from "../../../helper";\nimport rulesModule = require("./rules");\nconst { rules, Level } = rulesModule;\nexport = [{ rules: { ...rules, semi: Level.Error } }] satisfies FlatConfig[];';

							const teardown = createCustomTeardown({
								cwd,
								files: {
									"rules.ts":
										'import type { RulesRecord } from "../../../helper";\nimport { Severity } from "../../../helper";\nconst enum Level {\nError = 2,\nWarn = 1,\nOff = 0,\n};\nexport = { rules: { "no-undef": Severity.Error }, Level } satisfies RulesRecord;',
									"package.json": typeCommonJS,
									"eslint.config.ts": configFileContent,
									"foo.js": "foo",
								},
							});

							await teardown.prepare();

							eslint = new ESLint({
								cwd,
								flags,
							});

							const results = await eslint.lintFiles(["foo.js"]);

							assert.strictEqual(
								await eslint.findConfigFile(),
								path.join(cwd, "eslint.config.ts"),
							);
							assert.strictEqual(results.length, 1);
							assert.strictEqual(results[0].messages.length, 2);
							assert.strictEqual(
								results[0].messages[0].severity,
								2,
							);
							assert.strictEqual(
								results[0].messages[1].severity,
								2,
							);
							assert.strictEqual(
								results[0].messages[0].ruleId,
								"no-undef",
							);
						});

						it('should load eslint.config.ts with wildcard imports, "type": "module" in nearest `package.json`', async () => {
							const cwd = getFixturePath(
								"ts-config-files",
								"ts",
								"with-type-module",
								"wildcard-imports",
							);

							const configFileContent =
								'import type { FlatConfig } from "../../../helper";\nimport * as rulesModule from "./rules";\nconst { default: rules ,Level } = rulesModule;\nexport = [{ rules: { ...rules, semi: Level.Error } }] satisfies FlatConfig[];';

							const teardown = createCustomTeardown({
								cwd,
								files: {
									"rules.ts":
										'import type { RulesRecord } from "../../../helper";\nimport { Severity } from "../../../helper";\nexport const enum Level {\nError = 2,\nWarn = 1,\nOff = 0,\n};\nexport default { "no-undef": Severity.Error } satisfies RulesRecord;',
									"package.json": typeModule,
									"eslint.config.ts": configFileContent,
									"foo.js": "foo",
								},
							});

							await teardown.prepare();

							eslint = new ESLint({
								cwd,
								flags,
							});

							const results = await eslint.lintFiles(["foo.js"]);

							assert.strictEqual(
								await eslint.findConfigFile(),
								path.join(cwd, "eslint.config.ts"),
							);
							assert.strictEqual(results.length, 1);
							assert.strictEqual(results[0].messages.length, 2);
							assert.strictEqual(
								results[0].messages[0].severity,
								2,
							);
							assert.strictEqual(
								results[0].messages[1].severity,
								2,
							);
							assert.strictEqual(
								results[0].messages[0].ruleId,
								"no-undef",
							);
						});

						it('should load eslint.config.ts with wildcard imports, "type": "commonjs" in nearest `package.json`', async () => {
							const cwd = getFixturePath(
								"ts-config-files",
								"ts",
								"with-type-commonjs",
								"wildcard-imports",
							);

							const configFileContent =
								'import type { FlatConfig } from "../../../helper";\nimport * as rulesModule from "./rules";\nconst { default: rules ,Level } = rulesModule;\nexport = [{ rules: { ...rules, semi: Level.Error } }] satisfies FlatConfig[];';

							const teardown = createCustomTeardown({
								cwd,
								files: {
									"rules.ts":
										'import type { RulesRecord } from "../../../helper";\nimport { Severity } from "../../../helper";\nexport const enum Level {\nError = 2,\nWarn = 1,\nOff = 0,\n};\nexport default { "no-undef": Severity.Error } satisfies RulesRecord;',
									"package.json": typeCommonJS,
									"eslint.config.ts": configFileContent,
									"foo.js": "foo",
								},
							});

							await teardown.prepare();

							eslint = new ESLint({
								cwd,
								flags,
							});

							const results = await eslint.lintFiles(["foo.js"]);

							assert.strictEqual(
								await eslint.findConfigFile(),
								path.join(cwd, "eslint.config.ts"),
							);
							assert.strictEqual(results.length, 1);
							assert.strictEqual(results[0].messages.length, 2);
							assert.strictEqual(
								results[0].messages[0].severity,
								2,
							);
							assert.strictEqual(
								results[0].messages[1].severity,
								2,
							);
							assert.strictEqual(
								results[0].messages[0].ruleId,
								"no-undef",
							);
						});

						it('should load eslint.config.ts with CJS-ESM mixed syntax (import and module.exports), "type": "module" in nearest `package.json`', async () => {
							const cwd = getFixturePath(
								"ts-config-files",
								"ts",
								"with-type-module",
								"CJS-ESM-mixed-syntax",
								"import-and-module-exports",
							);

							const configFileContent =
								'import type { FlatConfig } from "../../../../helper";\nimport rules, { Level } from "./rules";\nmodule.exports = [{ rules: { ...rules, semi: Level.Error } }] satisfies FlatConfig[];';

							const teardown = createCustomTeardown({
								cwd,
								files: {
									"rules.ts": `import type { RulesRecord } from "../../../../helper";\nexport const enum Level {\nError = 2,\nWarn = 1,\nOff = 0,\n};\nexport default ${JSON.stringify(
										{
											"no-undef": 2,
										},
										null,
										2,
									)} satisfies RulesRecord;`,
									"package.json": typeModule,
									"eslint.config.ts": configFileContent,
									"foo.js": "foo",
								},
							});

							await teardown.prepare();

							eslint = new ESLint({
								cwd,
								flags,
							});

							const results = await eslint.lintFiles(["foo.js"]);

							assert.strictEqual(
								await eslint.findConfigFile(),
								path.join(cwd, "eslint.config.ts"),
							);
							assert.strictEqual(results.length, 1);
							assert.strictEqual(results[0].messages.length, 2);
							assert.strictEqual(
								results[0].messages[0].severity,
								2,
							);
							assert.strictEqual(
								results[0].messages[1].severity,
								2,
							);
							assert.strictEqual(
								results[0].messages[0].ruleId,
								"no-undef",
							);
						});

						it('should load eslint.config.ts with CJS-ESM mixed syntax (import and module.exports), "type": "commonjs" in nearest `package.json`', async () => {
							const cwd = getFixturePath(
								"ts-config-files",
								"ts",
								"with-type-commonjs",
								"CJS-ESM-mixed-syntax",
								"import-and-module-exports",
							);

							const configFileContent =
								'import type { FlatConfig } from "../../../../helper";\nimport rules, { Level } from "./rules";\nmodule.exports = [{ rules: { ...rules, semi: Level.Error } }] satisfies FlatConfig[];';

							const teardown = createCustomTeardown({
								cwd,
								files: {
									"rules.ts": `import type { RulesRecord } from "../../../../helper";\nexport const enum Level {\nError = 2,\nWarn = 1,\nOff = 0,\n};\nexport default ${JSON.stringify(
										{
											"no-undef": 2,
										},
										null,
										2,
									)} satisfies RulesRecord;`,
									"package.json": typeCommonJS,
									"eslint.config.ts": configFileContent,
									"foo.js": "foo",
								},
							});

							await teardown.prepare();

							eslint = new ESLint({
								cwd,
								flags,
							});

							const results = await eslint.lintFiles(["foo.js"]);

							assert.strictEqual(
								await eslint.findConfigFile(),
								path.join(cwd, "eslint.config.ts"),
							);
							assert.strictEqual(results.length, 1);
							assert.strictEqual(results[0].messages.length, 2);
							assert.strictEqual(
								results[0].messages[0].severity,
								2,
							);
							assert.strictEqual(
								results[0].messages[1].severity,
								2,
							);
							assert.strictEqual(
								results[0].messages[0].ruleId,
								"no-undef",
							);
						});

						it('should load eslint.config.ts with CJS-ESM mixed syntax (require and export default), "type": "module" in nearest `package.json`', async () => {
							const cwd = getFixturePath(
								"ts-config-files",
								"ts",
								"with-type-module",
								"CJS-ESM-mixed-syntax",
								"require-and-export-default",
							);

							const configFileContent =
								'import type { FlatConfig } from "../../../../helper";\nconst { default: rules, Level } = require("./rules");\nexport default [{ rules: { ...rules, semi: Level.Error } }] satisfies FlatConfig[];';

							const teardown = createCustomTeardown({
								cwd,
								files: {
									"rules.ts":
										'import type { RulesRecord } from "../../../../helper";\nimport { Severity } from "../../../../helper";\nexport const enum Level {\nError = 2,\nWarn = 1,\nOff = 0,\n};\nexport default { "no-undef": Severity.Error } satisfies RulesRecord;',
									"package.json": typeModule,
									"eslint.config.ts": configFileContent,
									"foo.js": "foo",
								},
							});

							await teardown.prepare();

							eslint = new ESLint({
								cwd,
								flags,
							});

							const results = await eslint.lintFiles(["foo.js"]);

							assert.strictEqual(
								await eslint.findConfigFile(),
								path.join(cwd, "eslint.config.ts"),
							);
							assert.strictEqual(results.length, 1);
							assert.strictEqual(results[0].messages.length, 2);
							assert.strictEqual(
								results[0].messages[0].severity,
								2,
							);
							assert.strictEqual(
								results[0].messages[1].severity,
								2,
							);
							assert.strictEqual(
								results[0].messages[0].ruleId,
								"no-undef",
							);
						});

						it('should load eslint.config.ts with CJS-ESM mixed syntax (require and export default), "type": "commonjs" in nearest `package.json`', async () => {
							const cwd = getFixturePath(
								"ts-config-files",
								"ts",
								"with-type-commonjs",
								"CJS-ESM-mixed-syntax",
								"require-and-export-default",
							);

							const configFileContent =
								'import type { FlatConfig } from "../../../../helper";\nconst { default: rules, Level } = require("./rules");\nexport default [{ rules: { ...rules, semi: Level.Error } }] satisfies FlatConfig[];';

							const teardown = createCustomTeardown({
								cwd,
								files: {
									"rules.ts":
										'import type { RulesRecord } from "../../../../helper";\nimport { Severity } from "../../../../helper";\nexport const enum Level {\nError = 2,\nWarn = 1,\nOff = 0,\n};\nexport default { "no-undef": Severity.Error } satisfies RulesRecord;',
									"package.json": typeCommonJS,
									"eslint.config.ts": configFileContent,
									"foo.js": "foo",
								},
							});

							await teardown.prepare();

							eslint = new ESLint({
								cwd,
								flags,
							});

							const results = await eslint.lintFiles(["foo.js"]);

							assert.strictEqual(
								await eslint.findConfigFile(),
								path.join(cwd, "eslint.config.ts"),
							);
							assert.strictEqual(results.length, 1);
							assert.strictEqual(results[0].messages.length, 2);
							assert.strictEqual(
								results[0].messages[0].severity,
								2,
							);
							assert.strictEqual(
								results[0].messages[1].severity,
								2,
							);
							assert.strictEqual(
								results[0].messages[0].ruleId,
								"no-undef",
							);
						});

						it('should load eslint.config.ts with CJS-ESM mixed syntax (import assignment and export default), "type": "module" in nearest `package.json`', async () => {
							const cwd = getFixturePath(
								"ts-config-files",
								"ts",
								"with-type-module",
								"CJS-ESM-mixed-syntax",
								"import-assignment-and-export-default",
							);

							const configFileContent =
								'import type { FlatConfig } from "../../../../helper";\nimport rulesModule = require("./rules");\nconst { default: rules, Level } = rulesModule;\nexport default [{ rules: { ...rules, semi: Level.Error } }] satisfies FlatConfig[];';

							const teardown = createCustomTeardown({
								cwd,
								files: {
									"rules.ts":
										'import type { RulesRecord } from "../../../../helper";\nimport { Severity } from "../../../../helper";\nexport const enum Level {\nError = 2,\nWarn = 1,\nOff = 0,\n};\nexport default { "no-undef": Severity.Error } satisfies RulesRecord;',
									"package.json": typeModule,
									"eslint.config.ts": configFileContent,
									"foo.js": "foo",
								},
							});

							await teardown.prepare();

							eslint = new ESLint({
								cwd,
								flags,
							});

							const results = await eslint.lintFiles(["foo.js"]);

							assert.strictEqual(
								await eslint.findConfigFile(),
								path.join(cwd, "eslint.config.ts"),
							);
							assert.strictEqual(results.length, 1);
							assert.strictEqual(results[0].messages.length, 2);
							assert.strictEqual(
								results[0].messages[0].severity,
								2,
							);
							assert.strictEqual(
								results[0].messages[1].severity,
								2,
							);
							assert.strictEqual(
								results[0].messages[0].ruleId,
								"no-undef",
							);
						});

						it('should load eslint.config.ts with CJS-ESM mixed syntax (import assignment and export default), "type": "commonjs" in nearest `package.json`', async () => {
							const cwd = getFixturePath(
								"ts-config-files",
								"ts",
								"with-type-commonjs",
								"CJS-ESM-mixed-syntax",
								"import-assignment-and-export-default",
							);

							const configFileContent =
								'import type { FlatConfig } from "../../../../helper";\nimport rulesModule = require("./rules");\nconst { default: rules, Level } = rulesModule;\nexport default [{ rules: { ...rules, semi: Level.Error } }] satisfies FlatConfig[];';

							const teardown = createCustomTeardown({
								cwd,
								files: {
									"rules.ts":
										'import type { RulesRecord } from "../../../../helper";\nimport { Severity } from "../../../../helper";\nexport const enum Level {\nError = 2,\nWarn = 1,\nOff = 0,\n};\nexport default { "no-undef": Severity.Error } satisfies RulesRecord;',
									"package.json": typeCommonJS,
									"eslint.config.ts": configFileContent,
									"foo.js": "foo",
								},
							});

							await teardown.prepare();

							eslint = new ESLint({
								cwd,
								flags,
							});

							const results = await eslint.lintFiles(["foo.js"]);

							assert.strictEqual(
								await eslint.findConfigFile(),
								path.join(cwd, "eslint.config.ts"),
							);
							assert.strictEqual(results.length, 1);
							assert.strictEqual(results[0].messages.length, 2);
							assert.strictEqual(
								results[0].messages[0].severity,
								2,
							);
							assert.strictEqual(
								results[0].messages[1].severity,
								2,
							);
							assert.strictEqual(
								results[0].messages[0].ruleId,
								"no-undef",
							);
						});

						it('should load eslint.config.ts with CJS-ESM mixed syntax (import and export assignment), "type": "module" in nearest `package.json`', async () => {
							const cwd = getFixturePath(
								"ts-config-files",
								"ts",
								"with-type-module",
								"CJS-ESM-mixed-syntax",
								"import-and-export-assignment",
							);

							const configFileContent =
								'import helpers = require("../../../../helper");\nimport rulesModule = require("./rules");\nconst { default: rules, Level } = rulesModule;\nconst allExports = [{ rules: { ...rules, semi: Level.Error } }] satisfies helpers.FlatConfig[];\nexport = allExports;';

							const teardown = createCustomTeardown({
								cwd,
								files: {
									"rules.ts":
										'import helpers = require("../../../../helper");\nconst enum Level {\nError = 2,\nWarn = 1,\nOff = 0,\n};\nconst rules = { "no-undef": helpers.Severity.Error } satisfies helpers.RulesRecord;\nconst allExports = { default: rules, Level };\nexport = allExports;',
									"package.json": typeModule,
									"eslint.config.ts": configFileContent,
									"foo.js": "foo",
								},
							});

							await teardown.prepare();

							eslint = new ESLint({
								cwd,
								flags,
							});

							const results = await eslint.lintFiles(["foo.js"]);

							assert.strictEqual(
								await eslint.findConfigFile(),
								path.join(cwd, "eslint.config.ts"),
							);
							assert.strictEqual(results.length, 1);
							assert.strictEqual(results[0].messages.length, 2);
							assert.strictEqual(
								results[0].messages[0].severity,
								2,
							);
							assert.strictEqual(
								results[0].messages[1].severity,
								2,
							);
							assert.strictEqual(
								results[0].messages[0].ruleId,
								"no-undef",
							);
						});

						it('should load eslint.config.ts with CJS-ESM mixed syntax (import and export assignment), "type": "commonjs" in nearest `package.json`', async () => {
							const cwd = getFixturePath(
								"ts-config-files",
								"ts",
								"with-type-commonjs",
								"CJS-ESM-mixed-syntax",
								"import-and-export-assignment",
							);

							const configFileContent =
								'import helpers = require("../../../../helper");\nimport rulesModule = require("./rules");\nconst { default: rules, Level } = rulesModule;\nconst allExports = [{ rules: { ...rules, semi: Level.Error } }] satisfies helpers.FlatConfig[];\nexport = allExports;';

							const teardown = createCustomTeardown({
								cwd,
								files: {
									"rules.ts":
										'import helpers = require("../../../../helper");\nconst enum Level {\nError = 2,\nWarn = 1,\nOff = 0,\n};\nconst rules = { "no-undef": helpers.Severity.Error } satisfies helpers.RulesRecord;\nconst allExports = { default: rules, Level };\nexport = allExports;',
									"package.json": typeCommonJS,
									"eslint.config.ts": configFileContent,
									"foo.js": "foo",
								},
							});

							await teardown.prepare();

							eslint = new ESLint({
								cwd,
								flags,
							});

							const results = await eslint.lintFiles(["foo.js"]);

							assert.strictEqual(
								await eslint.findConfigFile(),
								path.join(cwd, "eslint.config.ts"),
							);
							assert.strictEqual(results.length, 1);
							assert.strictEqual(results[0].messages.length, 2);
							assert.strictEqual(
								results[0].messages[0].severity,
								2,
							);
							assert.strictEqual(
								results[0].messages[1].severity,
								2,
							);
							assert.strictEqual(
								results[0].messages[0].ruleId,
								"no-undef",
							);
						});

						it("should load eslint.config.ts with const enums", async () => {
							const cwd = getFixturePath(
								"ts-config-files",
								"ts",
								"const-enums",
							);

							eslint = new ESLint({
								cwd,
								flags,
							});

							const results = await eslint.lintFiles("foo.js");

							assert.strictEqual(
								await eslint.findConfigFile(),
								path.join(cwd, "eslint.config.ts"),
							);
							assert.strictEqual(results.length, 1);
							assert.strictEqual(results[0].messages.length, 1);
							assert.strictEqual(
								results[0].messages[0].severity,
								2,
							);
							assert.strictEqual(
								results[0].messages[0].ruleId,
								"no-undef",
							);
						});

						it("should load eslint.config.ts with local namespace", async () => {
							const cwd = getFixturePath(
								"ts-config-files",
								"ts",
								"local-namespace",
							);

							eslint = new ESLint({
								cwd,
								flags,
							});

							const results = await eslint.lintFiles("foo.js");

							assert.strictEqual(
								await eslint.findConfigFile(),
								path.join(cwd, "eslint.config.ts"),
							);
							assert.strictEqual(results.length, 1);
							assert.strictEqual(results[0].messages.length, 1);
							assert.strictEqual(
								results[0].messages[0].severity,
								2,
							);
							assert.strictEqual(
								results[0].messages[0].ruleId,
								"no-undef",
							);
						});

						it("should allow passing a TS config file to `overrideConfigFile`", async () => {
							const cwd = getFixturePath(
								"ts-config-files",
								"ts",
								"custom-config",
							);

							const overrideConfigFile = path.join(
								cwd,
								"eslint.custom.config.ts",
							);

							eslint = new ESLint({
								cwd,
								flags,
								overrideConfigFile,
							});

							const results = await eslint.lintFiles("foo.js");

							assert.strictEqual(
								await eslint.findConfigFile(),
								overrideConfigFile,
							);
							assert.strictEqual(results.length, 1);
							assert.strictEqual(results[0].messages.length, 1);
							assert.strictEqual(
								results[0].messages[0].severity,
								2,
							);
							assert.strictEqual(
								results[0].messages[0].ruleId,
								"no-undef",
							);
						});

						it("should find and load eslint.config.mts when present", async () => {
							const cwd = getFixturePath(
								"ts-config-files",
								"mts",
							);

							eslint = new ESLint({
								cwd,
								flags,
							});

							const results = await eslint.lintFiles("foo.js");

							assert.strictEqual(
								await eslint.findConfigFile(),
								path.join(cwd, "eslint.config.mts"),
							);
							assert.strictEqual(results.length, 1);
							assert.strictEqual(results[0].messages.length, 1);
							assert.strictEqual(
								results[0].messages[0].severity,
								2,
							);
							assert.strictEqual(
								results[0].messages[0].ruleId,
								"no-undef",
							);
						});

						it('should load eslint.config.mts when we have "type": "commonjs" in nearest `package.json`', async () => {
							const cwd = getFixturePath(
								"ts-config-files",
								"mts",
								"with-type-commonjs",
							);

							eslint = new ESLint({
								cwd,
								flags,
							});

							const results = await eslint.lintFiles("foo.js");

							assert.strictEqual(
								await eslint.findConfigFile(),
								path.join(cwd, "eslint.config.mts"),
							);
							assert.strictEqual(results.length, 1);
							assert.strictEqual(results[0].messages.length, 1);
							assert.strictEqual(
								results[0].messages[0].severity,
								2,
							);
							assert.strictEqual(
								results[0].messages[0].ruleId,
								"no-undef",
							);
						});

						it('should load eslint.config.mts config file when we have "type": "module" in nearest `package.json`', async () => {
							const cwd = getFixturePath(
								"ts-config-files",
								"mts",
								"with-type-module",
							);

							eslint = new ESLint({
								cwd,
								flags,
							});

							const results = await eslint.lintFiles("foo.js");

							assert.strictEqual(
								await eslint.findConfigFile(),
								path.join(cwd, "eslint.config.mts"),
							);
							assert.strictEqual(results.length, 1);
							assert.strictEqual(results[0].messages.length, 1);
							assert.strictEqual(
								results[0].messages[0].severity,
								2,
							);
							assert.strictEqual(
								results[0].messages[0].ruleId,
								"no-undef",
							);
						});

						it("should find and load eslint.config.cts when present", async () => {
							const cwd = getFixturePath(
								"ts-config-files",
								"cts",
							);

							eslint = new ESLint({
								cwd,
								flags,
							});

							const results = await eslint.lintFiles("foo.js");

							assert.strictEqual(
								await eslint.findConfigFile(),
								path.join(cwd, "eslint.config.cts"),
							);
							assert.strictEqual(results.length, 1);
							assert.strictEqual(results[0].messages.length, 1);
							assert.strictEqual(
								results[0].messages[0].severity,
								2,
							);
							assert.strictEqual(
								results[0].messages[0].ruleId,
								"no-undef",
							);
						});

						it('should load eslint.config.cts config file when we have "type": "commonjs" in nearest `package.json`', async () => {
							const cwd = getFixturePath(
								"ts-config-files",
								"cts",
								"with-type-commonjs",
							);

							eslint = new ESLint({
								cwd,
								flags,
							});

							const results = await eslint.lintFiles("foo.js");

							assert.strictEqual(
								await eslint.findConfigFile(),
								path.join(cwd, "eslint.config.cts"),
							);
							assert.strictEqual(results.length, 1);
							assert.strictEqual(results[0].messages.length, 1);
							assert.strictEqual(
								results[0].messages[0].severity,
								2,
							);
							assert.strictEqual(
								results[0].messages[0].ruleId,
								"no-undef",
							);
						});

						it('should load .cts config file when we have "type": "module" in nearest `package.json`', async () => {
							const cwd = getFixturePath(
								"ts-config-files",
								"cts",
								"with-type-module",
							);

							eslint = new ESLint({
								cwd,
								flags,
							});

							const results = await eslint.lintFiles("foo.js");

							assert.strictEqual(
								await eslint.findConfigFile(),
								path.join(cwd, "eslint.config.cts"),
							);
							assert.strictEqual(results.length, 1);
							assert.strictEqual(results[0].messages.length, 1);
							assert.strictEqual(
								results[0].messages[0].severity,
								2,
							);
							assert.strictEqual(
								results[0].messages[0].ruleId,
								"no-undef",
							);
						});

						it("should not load extensions other than .ts, .mts or .cts", async () => {
							const cwd = getFixturePath(
								"ts-config-files",
								"wrong-extension",
							);

							const configFileContent = `import type { FlatConfig } from "../../helper";\nexport default ${JSON.stringify(
								[{ rules: { "no-undef": 2 } }],
								null,
								2,
							)} satisfies FlatConfig[];`;

							const teardown = createCustomTeardown({
								cwd,
								files: {
									"package.json": typeCommonJS,
									"eslint.config.mcts": configFileContent,
									"foo.js": "foo;",
								},
							});

							await teardown.prepare();

							eslint = new ESLint({
								cwd,
								overrideConfigFile: "eslint.config.mcts",
								flags,
							});

							assert.strictEqual(
								await eslint.findConfigFile(),
								path.join(cwd, "eslint.config.mcts"),
							);
							await assert.rejects(() =>
								eslint.lintFiles(["foo.js"]),
							);
						});

						it("should successfully load a TS config file that exports a promise", async () => {
							const cwd = getFixturePath(
								"ts-config-files",
								"ts",
								"exports-promise",
							);

							eslint = new ESLint({
								cwd,
								flags,
							});

							const results = await eslint.lintFiles(["foo*.js"]);

							assert.strictEqual(
								await eslint.findConfigFile(),
								path.join(cwd, "eslint.config.ts"),
							);
							assert.strictEqual(results.length, 1);
							assert.strictEqual(
								results[0].filePath,
								path.join(cwd, "foo.js"),
							);
							assert.strictEqual(results[0].messages.length, 1);
							assert.strictEqual(
								results[0].messages[0].severity,
								2,
							);
							assert.strictEqual(
								results[0].messages[0].ruleId,
								"no-undef",
							);
						});

						it("should load a CommonJS TS config file that exports undefined with a helpful warning message", async () => {
							sinon.restore();

							const cwd = getFixturePath("ts-config-files", "ts");
							const processStub = sinon.stub(
								process,
								"emitWarning",
							);

							eslint = new ESLint({
								cwd,
								flags,
								overrideConfigFile:
									"eslint.undefined.config.ts",
							});

							await eslint.lintFiles("foo.js");

							assert.strictEqual(
								processStub.callCount,
								1,
								"calls `process.emitWarning()` once",
							);
							assert.strictEqual(
								processStub.getCall(0).args[1],
								"ESLintEmptyConfigWarning",
							);
						});
					});
				});

				it("should fail to load a TS config file if jiti is not installed", async () => {
					sinon.stub(ConfigLoader, "loadJiti").rejects();

					const cwd = getFixturePath("ts-config-files", "ts");

					eslint = new ESLint({
						cwd,
						flags,
					});

					await assert.rejects(eslint.lintFiles("foo.js"), {
						message:
							"The 'jiti' library is required for loading TypeScript configuration files. Make sure to install it.",
					});
				});

				it("should fail to load a TS config file if an outdated version of jiti is installed", async () => {
					sinon
						.stub(ConfigLoader, "loadJiti")
						.resolves({ createJiti: void 0, version: "1.21.7" });

					const cwd = getFixturePath("ts-config-files", "ts");

					eslint = new ESLint({
						cwd,
						flags,
					});

					await assert.rejects(eslint.lintFiles("foo.js"), {
						message:
							"You are using an outdated version of the 'jiti' library. Please update to the latest version of 'jiti' to ensure compatibility and access to the latest features.",
					});
				});

				it("should handle jiti interopDefault edge cases", async () => {
					const cwd = getFixturePath(
						"ts-config-files",
						"ts",
						"jiti-interopDefault",
					);

					await fsp.writeFile(
						path.join(cwd, "eslint.config.ts"),
						`
						import plugin from "./plugin";

						export default plugin.configs.recommended;

						// Autogenerated on ${new Date().toISOString()}.`,
					);

					eslint = new ESLint({
						cwd,
						flags,
					});

					const results = await eslint.lintFiles("foo.js");

					assert.strictEqual(results.length, 1);
					assert.strictEqual(results[0].messages.length, 1);
					assert.strictEqual(results[0].messages[0].severity, 2);
					assert.strictEqual(
						results[0].messages[0].ruleId,
						"no-undef",
					);
				});

				// eslint-disable-next-line n/no-unsupported-features/node-builtins -- it's still an experimental feature.
				(typeof process.features.typescript === "string"
					? describe
					: describe.skip)(
					"Loading TypeScript config files natively",
					() => {
						beforeEach(() => {
							sinon.stub(ConfigLoader, "loadJiti").rejects();
						});

						describe("should load a TS config file when --experimental-strip-types is enabled", () => {
							it('with "type": "commonjs" in `package.json` and CJS syntax', async () => {
								const cwd = getFixturePath(
									"ts-config-files",
									"ts",
									"native",
									"with-type-commonjs",
									"CJS-syntax",
								);

								const configFileContent =
									'import type { FlatConfig, Severity } from "./helper.ts";\n\nconst eslintConfig = [\n  { rules: { "no-undef": 2 satisfies Severity.Error } },\n] satisfies FlatConfig[];\n\nmodule.exports = eslintConfig;\n';

								const teardown = createCustomTeardown({
									cwd,
									files: {
										"package.json": typeCommonJS,
										[eslintConfigFiles.ts]:
											configFileContent,
										"foo.js": "foo;",
										"helper.ts":
											'export type * from "../../../../helper.ts";\n',
									},
								});

								await teardown.prepare();

								eslint = new ESLint({
									cwd,
									overrideConfigFile: eslintConfigFiles.ts,
									flags: nativeTSConfigFileFlags,
								});

								const results = await eslint.lintFiles([
									"foo*.js",
								]);

								assert.strictEqual(
									await eslint.findConfigFile(),
									path.join(cwd, eslintConfigFiles.ts),
								);
								assert.strictEqual(results.length, 1);
								assert.strictEqual(
									results[0].filePath,
									path.join(cwd, "foo.js"),
								);
								assert.strictEqual(
									results[0].messages.length,
									1,
								);
								assert.strictEqual(
									results[0].messages[0].severity,
									2,
								);
								assert.strictEqual(
									results[0].messages[0].ruleId,
									"no-undef",
								);
							});

							it('with "type": "commonjs" in `package.json` and ESM syntax', async () => {
								const cwd = getFixturePath(
									"ts-config-files",
									"mts",
									"native",
									"with-type-commonjs",
									"ESM-syntax",
								);

								const configFileContent =
									'import type { FlatConfig, Severity } from "./helper.ts";\n\nconst eslintConfig = [\n  { rules: { "no-undef": 2 satisfies Severity.Error } },\n] satisfies FlatConfig[];\n\nexport default eslintConfig;\n';

								const teardown = createCustomTeardown({
									cwd,
									files: {
										"package.json": typeCommonJS,
										[eslintConfigFiles.mts]:
											configFileContent,
										"foo.js": "foo;",
										"helper.ts":
											'export type * from "../../../../helper.ts";\n',
									},
								});

								await teardown.prepare();

								eslint = new ESLint({
									cwd,
									overrideConfigFile: eslintConfigFiles.mts,
									flags: nativeTSConfigFileFlags,
								});

								const results = await eslint.lintFiles([
									"foo*.js",
								]);

								assert.strictEqual(
									await eslint.findConfigFile(),
									path.join(cwd, eslintConfigFiles.mts),
								);
								assert.strictEqual(results.length, 1);
								assert.strictEqual(
									results[0].filePath,
									path.join(cwd, "foo.js"),
								);
								assert.strictEqual(
									results[0].messages.length,
									1,
								);
								assert.strictEqual(
									results[0].messages[0].severity,
									2,
								);
								assert.strictEqual(
									results[0].messages[0].ruleId,
									"no-undef",
								);
							});

							it('with "type": "module" in `package.json` and CJS syntax', async () => {
								const cwd = getFixturePath(
									"ts-config-files",
									"cts",
									"native",
									"with-type-module",
									"CJS-syntax",
								);

								const configFileContent =
									'import type { FlatConfig, Severity } from "./helper.cts";\n\nconst eslintConfig = [\n  { rules: { "no-undef": 2 satisfies Severity.Error } },\n] satisfies FlatConfig[];\n\nmodule.exports = eslintConfig;\n';

								const teardown = createCustomTeardown({
									cwd,
									files: {
										"package.json": typeModule,
										[eslintConfigFiles.cts]:
											configFileContent,
										"foo.js": "foo;",
										"helper.cts":
											'export type * from "../../../../helper.ts";\n',
									},
								});

								await teardown.prepare();

								eslint = new ESLint({
									cwd,
									overrideConfigFile: eslintConfigFiles.cts,
									flags: nativeTSConfigFileFlags,
								});

								const results = await eslint.lintFiles([
									"foo*.js",
								]);

								assert.strictEqual(
									await eslint.findConfigFile(),
									path.join(cwd, eslintConfigFiles.cts),
								);
								assert.strictEqual(results.length, 1);
								assert.strictEqual(
									results[0].filePath,
									path.join(cwd, "foo.js"),
								);
								assert.strictEqual(
									results[0].messages.length,
									1,
								);
								assert.strictEqual(
									results[0].messages[0].severity,
									2,
								);
								assert.strictEqual(
									results[0].messages[0].ruleId,
									"no-undef",
								);
							});

							it('with "type": "module" in `package.json` and ESM syntax', async () => {
								const cwd = getFixturePath(
									"ts-config-files",
									"ts",
									"native",
									"with-type-module",
									"ESM-syntax",
								);

								const configFileContent =
									'import type { FlatConfig, Severity } from "./helper.cts";\n\nconst eslintConfig = [\n  { rules: { "no-undef": 2 satisfies Severity.Error } },\n] satisfies FlatConfig[];\n\nexport default eslintConfig;\n';

								const teardown = createCustomTeardown({
									cwd,
									files: {
										"package.json": typeModule,
										[eslintConfigFiles.ts]:
											configFileContent,
										"foo.js": "foo;",
										"helper.ts":
											'export type * from "../../../../helper.ts";\n',
									},
								});

								await teardown.prepare();

								eslint = new ESLint({
									cwd,
									overrideConfigFile: eslintConfigFiles.ts,
									flags: nativeTSConfigFileFlags,
								});

								const results = await eslint.lintFiles([
									"foo*.js",
								]);

								assert.strictEqual(
									await eslint.findConfigFile(),
									path.join(cwd, eslintConfigFiles.ts),
								);
								assert.strictEqual(results.length, 1);
								assert.strictEqual(
									results[0].filePath,
									path.join(cwd, "foo.js"),
								);
								assert.strictEqual(
									results[0].messages.length,
									1,
								);
								assert.strictEqual(
									results[0].messages[0].severity,
									2,
								);
								assert.strictEqual(
									results[0].messages[0].ruleId,
									"no-undef",
								);
							});
						});

						// eslint-disable-next-line n/no-unsupported-features/node-builtins -- it's still an experimental feature.
						(process.features.typescript === "transform"
							? describe
							: describe.skip)(
							"should load a TS config file when --experimental-transform-types is enabled",
							() => {
								it('with "type": "commonjs" in `package.json` and CJS syntax', async () => {
									const cwd = getFixturePath(
										"ts-config-files",
										"ts",
										"native",
										"with-type-commonjs",
										"CJS-syntax",
									);

									const configFileContent =
										'import ESLintNameSpace = require("./helper.ts");\n\nconst eslintConfig = [ { rules: { "no-undef": ESLintNameSpace.StringSeverity.Error } }]\n\nexport = eslintConfig;\n';

									const teardown = createCustomTeardown({
										cwd,
										files: {
											"package.json": typeCommonJS,
											[eslintConfigFiles.ts]:
												configFileContent,
											"foo.js": "foo;",
											"helper.ts":
												'namespace ESLintNameSpace {\n  export const enum StringSeverity {\n    "Off" = "off",\n    "Warn" = "warn",\n    "Error" = "error",\n  }\n}\n\nexport = ESLintNameSpace\n',
										},
									});

									await teardown.prepare();

									eslint = new ESLint({
										cwd,
										overrideConfigFile:
											eslintConfigFiles.ts,
										flags: nativeTSConfigFileFlags,
									});

									const results = await eslint.lintFiles([
										"foo*.js",
									]);

									assert.strictEqual(
										await eslint.findConfigFile(),
										path.join(cwd, eslintConfigFiles.ts),
									);
									assert.strictEqual(results.length, 1);
									assert.strictEqual(
										results[0].filePath,
										path.join(cwd, "foo.js"),
									);
									assert.strictEqual(
										results[0].messages.length,
										1,
									);
									assert.strictEqual(
										results[0].messages[0].severity,
										2,
									);
									assert.strictEqual(
										results[0].messages[0].ruleId,
										"no-undef",
									);
								});

								it('with "type": "commonjs" in `package.json` and ESM syntax', async () => {
									const cwd = getFixturePath(
										"ts-config-files",
										"ts",
										"native",
										"with-type-commonjs",
										"ESM-syntax",
									);

									const configFileContent =
										'import ESLintNameSpace from "./helper.ts";\n\nconst eslintConfig = [ { rules: { "no-undef": ESLintNameSpace.StringSeverity.Error } }]\n\nexport default eslintConfig;\n';

									const teardown = createCustomTeardown({
										cwd,
										files: {
											"package.json": typeCommonJS,
											[eslintConfigFiles.mts]:
												configFileContent,
											"foo.js": "foo;",
											"helper.ts":
												'namespace ESLintNameSpace {\n  export const enum StringSeverity {\n    "Off" = "off",\n    "Warn" = "warn",\n    "Error" = "error",\n  }\n}\n\nexport = ESLintNameSpace\n',
										},
									});

									await teardown.prepare();

									eslint = new ESLint({
										cwd,
										overrideConfigFile:
											eslintConfigFiles.mts,
										flags: nativeTSConfigFileFlags,
									});

									const results = await eslint.lintFiles([
										"foo*.js",
									]);

									assert.strictEqual(
										await eslint.findConfigFile(),
										path.join(cwd, eslintConfigFiles.mts),
									);
									assert.strictEqual(results.length, 1);
									assert.strictEqual(
										results[0].filePath,
										path.join(cwd, "foo.js"),
									);
									assert.strictEqual(
										results[0].messages.length,
										1,
									);
									assert.strictEqual(
										results[0].messages[0].severity,
										2,
									);
									assert.strictEqual(
										results[0].messages[0].ruleId,
										"no-undef",
									);
								});

								it('with "type": "module" in `package.json` and CJS syntax', async () => {
									const cwd = getFixturePath(
										"ts-config-files",
										"cts",
										"native",
										"with-type-module",
										"CJS-syntax",
									);

									const configFileContent =
										'import ESLintNameSpace = require("./helper.cts");\n\nconst eslintConfig = [ { rules: { "no-undef": ESLintNameSpace.StringSeverity.Error } }]\n\nexport = eslintConfig;\n';

									const teardown = createCustomTeardown({
										cwd,
										files: {
											"package.json": typeModule,
											[eslintConfigFiles.cts]:
												configFileContent,
											"foo.js": "foo;",
											"helper.cts":
												'namespace ESLintNameSpace {\n  export const enum StringSeverity {\n    "Off" = "off",\n    "Warn" = "warn",\n    "Error" = "error",\n  }\n}\n\nexport = ESLintNameSpace\n',
										},
									});

									await teardown.prepare();

									eslint = new ESLint({
										cwd,
										overrideConfigFile:
											eslintConfigFiles.cts,
										flags: nativeTSConfigFileFlags,
									});

									const results = await eslint.lintFiles([
										"foo*.js",
									]);

									assert.strictEqual(
										await eslint.findConfigFile(),
										path.join(cwd, eslintConfigFiles.cts),
									);
									assert.strictEqual(results.length, 1);
									assert.strictEqual(
										results[0].filePath,
										path.join(cwd, "foo.js"),
									);
									assert.strictEqual(
										results[0].messages.length,
										1,
									);
									assert.strictEqual(
										results[0].messages[0].severity,
										2,
									);
									assert.strictEqual(
										results[0].messages[0].ruleId,
										"no-undef",
									);
								});

								it('with "type": "module" in `package.json` and ESM syntax', async () => {
									const cwd = getFixturePath(
										"ts-config-files",
										"ts",
										"native",
										"with-type-module",
										"ESM-syntax",
									);

									const configFileContent =
										'import ESLintNameSpace from "./helper.ts";\n\nconst eslintConfig = [ { rules: { "no-undef": ESLintNameSpace.StringSeverity.Error } }]\n\nexport default eslintConfig;\n';

									const teardown = createCustomTeardown({
										cwd,
										files: {
											"package.json": typeModule,
											[eslintConfigFiles.ts]:
												configFileContent,
											"foo.js": "foo;",
											"helper.ts":
												'namespace ESLintNameSpace {\n  export const enum StringSeverity {\n    "Off" = "off",\n    "Warn" = "warn",\n    "Error" = "error",\n  }\n}\n\nexport default ESLintNameSpace\n',
										},
									});

									await teardown.prepare();

									eslint = new ESLint({
										cwd,
										overrideConfigFile:
											eslintConfigFiles.ts,
										flags: nativeTSConfigFileFlags,
									});

									const results = await eslint.lintFiles([
										"foo*.js",
									]);

									assert.strictEqual(
										await eslint.findConfigFile(),
										path.join(cwd, eslintConfigFiles.ts),
									);
									assert.strictEqual(results.length, 1);
									assert.strictEqual(
										results[0].filePath,
										path.join(cwd, "foo.js"),
									);
									assert.strictEqual(
										results[0].messages.length,
										1,
									);
									assert.strictEqual(
										results[0].messages[0].severity,
										2,
									);
									assert.strictEqual(
										results[0].messages[0].ruleId,
										"no-undef",
									);
								});

								it("fails without unstable_native_nodejs_ts_config if jiti is not installed", async () => {
									sinon.restore();

									const loadJitiStub = sinon
										.stub(ConfigLoader, "loadJiti")
										.rejects();

									const cwd = getFixturePath(
										"ts-config-files",
										"ts",
										"native",
										"edge-case-1",
									);

									const configFileContent =
										'import ESLintNameSpace from "./helper.ts";\n\nconst eslintConfig = [ { rules: { "no-undef": ESLintNameSpace.StringSeverity.Error } }]\n\nexport default eslintConfig;\n';

									const teardown = createCustomTeardown({
										cwd,
										files: {
											"package.json": typeModule,
											[eslintConfigFiles.ts]:
												configFileContent,
											"foo.js": "foo;",
											"helper.ts":
												'namespace ESLintNameSpace {\n  export const enum StringSeverity {\n    "Off" = "off",\n    "Warn" = "warn",\n    "Error" = "error",\n  }\n}\n\nexport default ESLintNameSpace\n',
										},
									});

									await teardown.prepare();

									eslint = new ESLint({
										cwd,
										overrideConfigFile:
											eslintConfigFiles.ts,
										flags,
									});

									await assert.rejects(
										eslint.lintFiles(["foo*.js"]),
										{
											message:
												"The 'jiti' library is required for loading TypeScript configuration files. Make sure to install it.",
										},
									);

									loadJitiStub.restore();
								});

								it("fails without unstable_native_nodejs_ts_config if jiti is outdated", async () => {
									sinon.restore();

									const loadJitiStub = sinon
										.stub(ConfigLoader, "loadJiti")
										.resolves({
											createJiti: void 0,
											version: "1.21.7",
										});

									const cwd = getFixturePath(
										"ts-config-files",
										"ts",
										"native",
										"edge-case-2",
									);

									const configFileContent =
										'import ESLintNameSpace from "./helper.ts";\n\nconst eslintConfig = [ { rules: { "no-undef": ESLintNameSpace.StringSeverity.Error } }]\n\nexport default eslintConfig;\n';

									const teardown = createCustomTeardown({
										cwd,
										files: {
											"package.json": typeModule,
											[eslintConfigFiles.ts]:
												configFileContent,
											"foo.js": "foo;",
											"helper.ts":
												'namespace ESLintNameSpace {\n  export const enum StringSeverity {\n    "Off" = "off",\n    "Warn" = "warn",\n    "Error" = "error",\n  }\n}\n\nexport default ESLintNameSpace\n',
										},
									});

									await teardown.prepare();

									eslint = new ESLint({
										cwd,
										overrideConfigFile:
											eslintConfigFiles.ts,
										flags,
									});

									await assert.rejects(
										eslint.lintFiles(["foo*.js"]),
										{
											message:
												"You are using an outdated version of the 'jiti' library. Please update to the latest version of 'jiti' to ensure compatibility and access to the latest features.",
										},
									);

									loadJitiStub.restore();
								});
							},
						);
					},
				);

				// eslint-disable-next-line n/no-unsupported-features/node-builtins -- it's still an experimental feature.
				(typeof process.features.typescript === "undefined"
					? it
					: it.skip)(
					"should throw an error if unstable_native_nodejs_ts_config is set but --experimental-strip-types is not enabled and process.features.typescript is undefined",
					async () => {
						const cwd = getFixturePath(
							"ts-config-files",
							"ts",
							"native",
						);

						const configFileContent = `import type { FlatConfig } from "./helper.ts";\nexport default ${JSON.stringify(
							[{ rules: { "no-undef": 2 } }],
							null,
							2,
						)} satisfies FlatConfig[];`;

						const teardown = createCustomTeardown({
							cwd,
							files: {
								"package.json": typeModule,
								[eslintConfigFiles.ts]: configFileContent,
								"foo.js": "foo;",
								"helper.ts":
									'import type { Linter } from "eslint";\nexport type FlatConfig = Linter.Config;\n',
							},
						});

						await teardown.prepare();

						eslint = new ESLint({
							cwd,
							overrideConfigFile: eslintConfigFiles.ts,
							flags: nativeTSConfigFileFlags,
						});

						await assert.rejects(eslint.lintFiles(["foo*.js"]), {
							message:
								"The unstable_native_nodejs_ts_config flag is not supported in older versions of Node.js.",
						});
					},
				);

				// eslint-disable-next-line n/no-unsupported-features/node-builtins -- it's still an experimental feature.
				(process.features.typescript === false ? it : it.skip)(
					"should throw an error if unstable_native_nodejs_ts_config is set but --experimental-strip-types is not enabled and process.features.typescript is false",
					async () => {
						const cwd = getFixturePath(
							"ts-config-files",
							"ts",
							"native",
						);

						const configFileContent = `import type { FlatConfig } from "./helper.ts";\nexport default ${JSON.stringify(
							[{ rules: { "no-undef": 2 } }],
							null,
							2,
						)} satisfies FlatConfig[];`;

						const teardown = createCustomTeardown({
							cwd,
							files: {
								"package.json": typeModule,
								[eslintConfigFiles.ts]: configFileContent,
								"foo.js": "foo;",
								"helper.ts":
									'import type { Linter } from "eslint";\nexport type FlatConfig = Linter.Config;\n',
							},
						});

						await teardown.prepare();

						eslint = new ESLint({
							cwd,
							overrideConfigFile: eslintConfigFiles.ts,
							flags: nativeTSConfigFileFlags,
						});

						await assert.rejects(eslint.lintFiles(["foo*.js"]), {
							message:
								"The unstable_native_nodejs_ts_config flag is enabled, but native TypeScript support is not enabled in the current Node.js process. You need to either enable native TypeScript support by passing --experimental-strip-types or remove the unstable_native_nodejs_ts_config flag.",
						});
					},
				);
			});

			it("should stop linting files if a rule crashes", async () => {
				const cwd = getFixturePath("files");
				let createCallCount = 0;

				eslint = new ESLint({
					flags,
					cwd,
					plugins: {
						boom: {
							rules: {
								boom: {
									create() {
										createCallCount++;
										throw Error("Boom!");
									},
								},
							},
						},
					},
					baseConfig: {
						rules: {
							"boom/boom": "error",
						},
					},
				});

				await assert.rejects(eslint.lintFiles("*.js"));

				// Wait until all files have been closed.
				// eslint-disable-next-line n/no-unsupported-features/node-builtins -- it's still an experimental feature.
				while (process.getActiveResourcesInfo().includes("CloseReq")) {
					await timers.setImmediate();
				}
				assert.strictEqual(createCallCount, 1);
			});

			// https://github.com/eslint/eslint/issues/19243
			it("should not exit the process unexpectedly after a rule crashes", async () => {
				const cwd = getFixturePath();

				/*
				 * Mocha attaches `unhandledRejection` event handlers to the current process.
				 * To test without global handlers, we must launch a new process.
				 */
				const teardown = createCustomTeardown({
					cwd,
					files: {
						"test.js": `
                        const { ESLint } = require(${JSON.stringify(require.resolve("eslint"))});

                        const eslint = new ESLint({
                            flags: ${JSON.stringify(flags)},
                            overrideConfigFile: true,
                            plugins: {
                                boom: {
                                    rules: {
                                        boom: {
                                            create: () => ({
                                                "*"() {
                                                    throw "Boom!";
                                                },
                                            }),
                                        }
                                    }
                                }
                            },
                            baseConfig: {
                                rules: {
                                    "boom/boom": "error"
                                }
                            }
                        });

                        eslint.lintFiles("passing.js").catch(() => { });
                        `,
					},
				});

				await teardown.prepare();
				const execFile = util.promisify(
					require("node:child_process").execFile,
				);

				await execFile(process.execPath, ["test.js"], { cwd });
			});

			describe("Error while globbing", () => {
				it("should throw an error with a glob pattern if an invalid config was provided", async () => {
					const cwd = getFixturePath("files");

					eslint = new ESLint({
						flags,
						cwd,
						overrideConfig: [{ invalid: "foobar" }],
					});

					await assert.rejects(eslint.lintFiles("*.js"));
				});
			});

			describe("patterns with './' prefix", () => {
				const root = getFixturePath(
					"cli-engine/patterns-with-dot-prefix",
				);

				let cleanup;
				let i = 0;

				beforeEach(() => {
					cleanup = () => {};
					i++;
				});

				afterEach(() => cleanup());

				it("should match patterns with './' prefix in `files` patterns", async () => {
					const teardown = createCustomTeardown({
						cwd: `${root}${i}`,
						files: {
							"src/foo.js": "undefinedVariable;",
							"eslint.config.js": `module.exports = [{
								files: ["./src/*.js"],
								rules: { "no-undef": "error" }
							}];`,
						},
					});

					await teardown.prepare();
					cleanup = teardown.cleanup;

					eslint = new ESLint({ flags, cwd: teardown.getPath() });
					const results = await eslint.lintFiles("src/**/*.js");

					assert.strictEqual(results.length, 1);
					assert.strictEqual(
						results[0].filePath,
						path.join(teardown.getPath(), "src/foo.js"),
					);
					assert.strictEqual(results[0].messages.length, 1);
					assert.strictEqual(
						results[0].messages[0].ruleId,
						"no-undef",
					);
					assert.strictEqual(results[0].messages[0].severity, 2);
				});

				it("should match patterns with './' prefix in `ignores` patterns", async () => {
					const teardown = createCustomTeardown({
						cwd: `${root}${i}`,
						files: {
							"src/foo.js": "undefinedVariable;",
							"eslint.config.js": `module.exports = [{
								files: ["**/*.js"],
								ignores: ["./src/*.js"],
								rules: { "no-undef": "error" }
							}];`,
						},
					});

					await teardown.prepare();
					cleanup = teardown.cleanup;

					eslint = new ESLint({ flags, cwd: teardown.getPath() });
					const results = await eslint.lintFiles("src/**/*.js");

					assert.strictEqual(results.length, 1);
					assert.strictEqual(
						results[0].filePath,
						path.join(teardown.getPath(), "src/foo.js"),
					);
					assert.strictEqual(results[0].messages.length, 0);
				});

				it("should match patterns with './' prefix in global `ignores` patterns", async () => {
					const teardown = createCustomTeardown({
						cwd: `${root}${i}`,
						files: {
							"src/foo.js": "undefinedVariable;",
							"eslint.config.js": `module.exports = [
								{
									files: ["**/*.js"],
									rules: { "no-undef": "error" }
								},
								{
									ignores: ["./src/*.js"]
								}
							];`,
						},
					});

					await teardown.prepare();
					cleanup = teardown.cleanup;

					eslint = new ESLint({ flags, cwd: teardown.getPath() });

					await assert.rejects(async () => {
						await eslint.lintFiles("src/**/*.js");
					}, /All files matched by 'src\/\*\*\/\*\.js' are ignored\./u);
				});

				it("should match negated `files` patterns with './' prefix", async () => {
					const teardown = createCustomTeardown({
						cwd: `${root}${i}`,
						files: {
							"src/foo.js": "undefinedVariable;",
							"eslint.config.js": `module.exports = [{
								files: ["!./src/*.js"],
								rules: { "no-undef": "error" }
							}];`,
						},
					});

					await teardown.prepare();
					cleanup = teardown.cleanup;

					eslint = new ESLint({ flags, cwd: teardown.getPath() });
					const results = await eslint.lintFiles("src/**/*.js");

					assert.strictEqual(results.length, 1);
					assert.strictEqual(
						results[0].filePath,
						path.join(teardown.getPath(), "src/foo.js"),
					);
					assert.strictEqual(results[0].messages.length, 0);
				});

				it("should match negated `ignores` patterns with './' prefix", async () => {
					const teardown = createCustomTeardown({
						cwd: `${root}${i}`,
						files: {
							"src/foo.js": "undefinedVariable;",
							"eslint.config.js": `module.exports = [{
								files: ["**/*.js"],
								ignores: ["**/*.js", "!./src/foo.js"],
								rules: { "no-undef": "error" }
							}];`,
						},
					});

					await teardown.prepare();
					cleanup = teardown.cleanup;

					eslint = new ESLint({ flags, cwd: teardown.getPath() });
					const results = await eslint.lintFiles("src/**/*.js");

					assert.strictEqual(results.length, 1);
					assert.strictEqual(
						results[0].filePath,
						path.join(teardown.getPath(), "src/foo.js"),
					);
					assert.strictEqual(results[0].messages.length, 1);
					assert.strictEqual(
						results[0].messages[0].ruleId,
						"no-undef",
					);
					assert.strictEqual(results[0].messages[0].severity, 2);
				});

				it("should match negated global `ignores` patterns with './' prefix", async () => {
					const teardown = createCustomTeardown({
						cwd: `${root}${i}`,
						files: {
							"src/foo.js": "undefinedVariable;",
							"eslint.config.js": `module.exports = [
								{
									files: ["**/*.js"],
									rules: { "no-undef": "error" }
								},
								{
									ignores: ["**/*.js", "!./src/*.js"]
								}
							];`,
						},
					});

					await teardown.prepare();
					cleanup = teardown.cleanup;

					eslint = new ESLint({ flags, cwd: teardown.getPath() });
					const results = await eslint.lintFiles("src/**/*.js");

					assert.strictEqual(results.length, 1);
					assert.strictEqual(
						results[0].filePath,
						path.join(teardown.getPath(), "src/foo.js"),
					);
					assert.strictEqual(results[0].messages.length, 1);
					assert.strictEqual(
						results[0].messages[0].ruleId,
						"no-undef",
					);
					assert.strictEqual(results[0].messages[0].severity, 2);
				});

				it("should match nested `files` patterns with './' prefix", async () => {
					const teardown = createCustomTeardown({
						cwd: `${root}${i}`,
						files: {
							"src/foo.js": "undefinedVariable;",
							"eslint.config.js": `module.exports = [{
								files: [["./src/*.js"]],
								rules: { "no-undef": "error" }
							}];`,
						},
					});

					await teardown.prepare();
					cleanup = teardown.cleanup;

					eslint = new ESLint({ flags, cwd: teardown.getPath() });
					const results = await eslint.lintFiles("src/**/*.js");

					assert.strictEqual(results.length, 1);
					assert.strictEqual(
						results[0].filePath,
						path.join(teardown.getPath(), "src/foo.js"),
					);
					assert.strictEqual(results[0].messages.length, 1);
					assert.strictEqual(
						results[0].messages[0].ruleId,
						"no-undef",
					);
					assert.strictEqual(results[0].messages[0].severity, 2);
				});
			});

			describe("Config objects with `basePath` property", () => {
				const cwd = getFixturePath("config-base-path");

				it("should only be applied to files inside the config's base path when no `files` or `ignores` are specified", async () => {
					eslint = new ESLint({
						flags,
						cwd,
						overrideConfigFile: true,
						overrideConfig: [
							{
								basePath: "subdir",
								rules: {
									"no-unused-vars": "warn",
								},
							},
						],
					});

					const results = await eslint.lintFiles(["."]);

					assert.strictEqual(results.length, 4);

					assert.strictEqual(
						results[0].filePath,
						path.resolve(cwd, "a.js"),
					);
					assert.strictEqual(results[0].messages.length, 0);

					assert.strictEqual(
						results[1].filePath,
						path.resolve(cwd, "b.js"),
					);
					assert.strictEqual(results[1].messages.length, 0);

					assert.strictEqual(
						results[2].filePath,
						path.resolve(cwd, "subdir/a.js"),
					);
					assert.strictEqual(results[2].messages.length, 1);
					assert.strictEqual(
						results[2].messages[0].ruleId,
						"no-unused-vars",
					);
					assert.strictEqual(results[2].messages[0].severity, 1);

					assert.strictEqual(
						results[3].filePath,
						path.resolve(cwd, "subdir/b.js"),
					);
					assert.strictEqual(results[3].messages.length, 1);
					assert.strictEqual(
						results[3].messages[0].ruleId,
						"no-unused-vars",
					);
					assert.strictEqual(results[3].messages[0].severity, 1);
				});

				it("should only be applied to files inside the config's base path when `files` are specified", async () => {
					eslint = new ESLint({
						flags,
						cwd,
						overrideConfigFile: true,
						overrideConfig: [
							{
								basePath: "subdir",
								files: ["a.js"],
								rules: {
									"no-unused-vars": "warn",
								},
							},
						],
					});

					const results = await eslint.lintFiles(["."]);

					assert.strictEqual(results.length, 4);

					assert.strictEqual(
						results[0].filePath,
						path.resolve(cwd, "a.js"),
					);
					assert.strictEqual(results[0].messages.length, 0);

					assert.strictEqual(
						results[1].filePath,
						path.resolve(cwd, "b.js"),
					);
					assert.strictEqual(results[1].messages.length, 0);

					assert.strictEqual(
						results[2].filePath,
						path.resolve(cwd, "subdir/a.js"),
					);
					assert.strictEqual(results[2].messages.length, 1);
					assert.strictEqual(
						results[2].messages[0].ruleId,
						"no-unused-vars",
					);
					assert.strictEqual(results[2].messages[0].severity, 1);

					assert.strictEqual(
						results[3].filePath,
						path.resolve(cwd, "subdir/b.js"),
					);
					assert.strictEqual(results[3].messages.length, 0);
				});

				it("should only be applied to files inside the config's base path when non-global `ignores` are specified", async () => {
					eslint = new ESLint({
						flags,
						cwd,
						overrideConfigFile: true,
						overrideConfig: [
							{
								basePath: "subdir",
								ignores: ["a.js"],
								rules: {
									"no-unused-vars": "warn",
								},
							},
						],
					});

					const results = await eslint.lintFiles(["."]);

					assert.strictEqual(results.length, 4);

					assert.strictEqual(
						results[0].filePath,
						path.resolve(cwd, "a.js"),
					);
					assert.strictEqual(results[0].messages.length, 0);

					assert.strictEqual(
						results[1].filePath,
						path.resolve(cwd, "b.js"),
					);
					assert.strictEqual(results[1].messages.length, 0);

					assert.strictEqual(
						results[2].filePath,
						path.resolve(cwd, "subdir/a.js"),
					);
					assert.strictEqual(results[2].messages.length, 0);

					assert.strictEqual(
						results[3].filePath,
						path.resolve(cwd, "subdir/b.js"),
					);
					assert.strictEqual(results[3].messages.length, 1);
					assert.strictEqual(
						results[3].messages[0].ruleId,
						"no-unused-vars",
					);
					assert.strictEqual(results[3].messages[0].severity, 1);
				});

				it("should only be applied to files inside the config's base path when both `files` and `ignores` are specified", async () => {
					eslint = new ESLint({
						flags,
						cwd,
						overrideConfigFile: true,
						overrideConfig: [
							{
								basePath: "subdir",
								files: ["**/*.js"],
								ignores: ["a.js"],
								rules: {
									"no-unused-vars": "warn",
								},
							},
						],
					});

					const results = await eslint.lintFiles(["."]);

					assert.strictEqual(results.length, 4);

					assert.strictEqual(
						results[0].filePath,
						path.resolve(cwd, "a.js"),
					);
					assert.strictEqual(results[0].messages.length, 0);

					assert.strictEqual(
						results[1].filePath,
						path.resolve(cwd, "b.js"),
					);
					assert.strictEqual(results[1].messages.length, 0);

					assert.strictEqual(
						results[2].filePath,
						path.resolve(cwd, "subdir/a.js"),
					);
					assert.strictEqual(results[2].messages.length, 0);

					assert.strictEqual(
						results[3].filePath,
						path.resolve(cwd, "subdir/b.js"),
					);
					assert.strictEqual(results[3].messages.length, 1);
					assert.strictEqual(
						results[3].messages[0].ruleId,
						"no-unused-vars",
					);
					assert.strictEqual(results[3].messages[0].severity, 1);
				});

				it("should interpret `basePath` as relative to the config file location", async () => {
					eslint = new ESLint({
						flags,
						cwd,
						overrideConfig: [
							{
								basePath: "config-base-path/subdir", // config file is in the parent's parent directory
								rules: {
									"no-unused-vars": "warn",
								},
							},
						],
					});

					const results = await eslint.lintFiles(["."]);

					assert.strictEqual(results.length, 4);

					assert.strictEqual(
						results[0].filePath,
						path.resolve(cwd, "a.js"),
					);
					assert.strictEqual(results[0].messages.length, 0);

					assert.strictEqual(
						results[1].filePath,
						path.resolve(cwd, "b.js"),
					);
					assert.strictEqual(results[1].messages.length, 0);

					assert.strictEqual(
						results[2].filePath,
						path.resolve(cwd, "subdir/a.js"),
					);
					assert.strictEqual(results[2].messages.length, 1);
					assert.strictEqual(
						results[2].messages[0].ruleId,
						"no-unused-vars",
					);
					assert.strictEqual(results[2].messages[0].severity, 1);

					assert.strictEqual(
						results[3].filePath,
						path.resolve(cwd, "subdir/b.js"),
					);
					assert.strictEqual(results[3].messages.length, 1);
					assert.strictEqual(
						results[3].messages[0].ruleId,
						"no-unused-vars",
					);
					assert.strictEqual(results[3].messages[0].severity, 1);
				});

				it("should interpret global ignores as relative to `basePath` when ignoring files", async () => {
					eslint = new ESLint({
						flags,
						cwd,
						overrideConfigFile: true,
						overrideConfig: [
							{
								basePath: "subdir",
								ignores: ["a.js"],
							},
						],
					});

					const results = await eslint.lintFiles(["."]);

					assert.strictEqual(results.length, 3);

					assert.strictEqual(
						results[0].filePath,
						path.resolve(cwd, "a.js"),
					);
					assert.strictEqual(results[0].messages.length, 0);

					assert.strictEqual(
						results[1].filePath,
						path.resolve(cwd, "b.js"),
					);
					assert.strictEqual(results[1].messages.length, 0);

					assert.strictEqual(
						results[2].filePath,
						path.resolve(cwd, "subdir/b.js"),
					);
					assert.strictEqual(results[2].messages.length, 0);
				});

				it("should interpret global ignores as relative to `basePath` when ignoring directories", async () => {
					eslint = new ESLint({
						flags,
						cwd,
						overrideConfig: [
							{
								basePath: "config-base-path", // config file is in the parent directory
								ignores: ["subdir"],
							},
						],
					});

					const results = await eslint.lintFiles(["."]);

					assert.strictEqual(results.length, 2);

					assert.strictEqual(
						results[0].filePath,
						path.resolve(cwd, "a.js"),
					);
					assert.strictEqual(results[0].messages.length, 0);

					assert.strictEqual(
						results[1].filePath,
						path.resolve(cwd, "b.js"),
					);
					assert.strictEqual(results[1].messages.length, 0);
				});

				it("should not apply global ignores when the `ignore` option is `false`", async () => {
					eslint = new ESLint({
						flags,
						cwd,
						overrideConfigFile: true,
						overrideConfig: [
							{
								basePath: "subdir",
								ignores: ["a.js"],
							},
						],
						ignore: false,
					});

					const results = await eslint.lintFiles(["."]);

					assert.strictEqual(results.length, 4);

					assert.strictEqual(
						results[0].filePath,
						path.resolve(cwd, "a.js"),
					);
					assert.strictEqual(results[0].messages.length, 0);

					assert.strictEqual(
						results[1].filePath,
						path.resolve(cwd, "b.js"),
					);
					assert.strictEqual(results[1].messages.length, 0);

					assert.strictEqual(
						results[2].filePath,
						path.resolve(cwd, "subdir/a.js"),
					);
					assert.strictEqual(results[2].messages.length, 0);

					assert.strictEqual(
						results[3].filePath,
						path.resolve(cwd, "subdir/b.js"),
					);
					assert.strictEqual(results[3].messages.length, 0);
				});
			});
		});

		describe("Fix Types", () => {
			/** @type {InstanceType<ESLint>} */
			let eslint;

			describe("fixTypes values validation", () => {
				it("should throw an error when an invalid fix type is specified", () => {
					assert.throws(() => {
						eslint = new ESLint({
							flags,
							cwd: path.join(fixtureDir, ".."),
							overrideConfigFile: true,
							fix: true,
							fixTypes: ["layou"],
						});
					}, /'fixTypes' must be an array of any of "directive", "problem", "suggestion", and "layout"\./iu);
				});
			});

			describe("with lintFiles", () => {
				it("should not fix any rules when fixTypes is used without fix", async () => {
					eslint = new ESLint({
						flags,
						cwd: path.join(fixtureDir, ".."),
						overrideConfigFile: true,
						fix: false,
						fixTypes: ["layout"],
					});
					const inputPath = getFixturePath(
						"fix-types/fix-only-semi.js",
					);
					const results = await eslint.lintFiles([inputPath]);

					assert.strictEqual(results[0].output, void 0);
				});

				it("should not fix non-style rules when fixTypes has only 'layout'", async () => {
					eslint = new ESLint({
						flags,
						cwd: path.join(fixtureDir, ".."),
						overrideConfigFile: true,
						fix: true,
						fixTypes: ["layout"],
					});
					const inputPath = getFixturePath(
						"fix-types/fix-only-semi.js",
					);
					const outputPath = getFixturePath(
						"fix-types/fix-only-semi.expected.js",
					);
					const results = await eslint.lintFiles([inputPath]);
					const expectedOutput = fs.readFileSync(outputPath, "utf8");

					assert.strictEqual(results[0].output, expectedOutput);
				});

				it("should not fix style or problem rules when fixTypes has only 'suggestion'", async () => {
					eslint = new ESLint({
						flags,
						cwd: path.join(fixtureDir, ".."),
						overrideConfigFile: true,
						fix: true,
						fixTypes: ["suggestion"],
					});
					const inputPath = getFixturePath(
						"fix-types/fix-only-prefer-arrow-callback.js",
					);
					const outputPath = getFixturePath(
						"fix-types/fix-only-prefer-arrow-callback.expected.js",
					);
					const results = await eslint.lintFiles([inputPath]);
					const expectedOutput = fs.readFileSync(outputPath, "utf8");

					assert.strictEqual(results[0].output, expectedOutput);
				});

				it("should fix both style and problem rules when fixTypes has 'suggestion' and 'layout'", async () => {
					eslint = new ESLint({
						flags,
						cwd: path.join(fixtureDir, ".."),
						overrideConfigFile: true,
						fix: true,
						fixTypes: ["suggestion", "layout"],
					});
					const inputPath = getFixturePath(
						"fix-types/fix-both-semi-and-prefer-arrow-callback.js",
					);
					const outputPath = getFixturePath(
						"fix-types/fix-both-semi-and-prefer-arrow-callback.expected.js",
					);
					const results = await eslint.lintFiles([inputPath]);
					const expectedOutput = fs.readFileSync(outputPath, "utf8");

					assert.strictEqual(results[0].output, expectedOutput);
				});
			});

			describe("with lintText", () => {
				it("should not fix any rules when fixTypes is used without fix", async () => {
					eslint = new ESLint({
						flags,
						cwd: path.join(fixtureDir, ".."),
						overrideConfigFile: true,
						fix: false,
						fixTypes: ["layout"],
					});
					const inputPath = getFixturePath(
						"fix-types/fix-only-semi.js",
					);
					const content = fs.readFileSync(inputPath, "utf8");
					const results = await eslint.lintText(content, {
						filePath: inputPath,
					});

					assert.strictEqual(results[0].output, void 0);
				});

				it("should not fix non-style rules when fixTypes has only 'layout'", async () => {
					eslint = new ESLint({
						flags,
						cwd: path.join(fixtureDir, ".."),
						overrideConfigFile: true,
						fix: true,
						fixTypes: ["layout"],
					});
					const inputPath = getFixturePath(
						"fix-types/fix-only-semi.js",
					);
					const outputPath = getFixturePath(
						"fix-types/fix-only-semi.expected.js",
					);
					const content = fs.readFileSync(inputPath, "utf8");
					const results = await eslint.lintText(content, {
						filePath: inputPath,
					});
					const expectedOutput = fs.readFileSync(outputPath, "utf8");

					assert.strictEqual(results[0].output, expectedOutput);
				});

				it("should not fix style or problem rules when fixTypes has only 'suggestion'", async () => {
					eslint = new ESLint({
						flags,
						cwd: path.join(fixtureDir, ".."),
						overrideConfigFile: true,
						fix: true,
						fixTypes: ["suggestion"],
					});
					const inputPath = getFixturePath(
						"fix-types/fix-only-prefer-arrow-callback.js",
					);
					const outputPath = getFixturePath(
						"fix-types/fix-only-prefer-arrow-callback.expected.js",
					);
					const content = fs.readFileSync(inputPath, "utf8");
					const results = await eslint.lintText(content, {
						filePath: inputPath,
					});
					const expectedOutput = fs.readFileSync(outputPath, "utf8");

					assert.strictEqual(results[0].output, expectedOutput);
				});

				it("should fix both style and problem rules when fixTypes has 'suggestion' and 'layout'", async () => {
					eslint = new ESLint({
						flags,
						cwd: path.join(fixtureDir, ".."),
						overrideConfigFile: true,
						fix: true,
						fixTypes: ["suggestion", "layout"],
					});
					const inputPath = getFixturePath(
						"fix-types/fix-both-semi-and-prefer-arrow-callback.js",
					);
					const outputPath = getFixturePath(
						"fix-types/fix-both-semi-and-prefer-arrow-callback.expected.js",
					);
					const content = fs.readFileSync(inputPath, "utf8");
					const results = await eslint.lintText(content, {
						filePath: inputPath,
					});
					const expectedOutput = fs.readFileSync(outputPath, "utf8");

					assert.strictEqual(results[0].output, expectedOutput);
				});
			});
		});

		describe("isPathIgnored", () => {
			it("should check if the given path is ignored", async () => {
				const engine = new ESLint({
					flags,
					overrideConfigFile: getFixturePath(
						"eslint.config-with-ignores2.js",
					),
					cwd: getFixturePath(),
				});

				assert(await engine.isPathIgnored("undef.js"));
				assert(!(await engine.isPathIgnored("passing.js")));
			});

			it("should return false if ignoring is disabled", async () => {
				const engine = new ESLint({
					flags,
					ignore: false,
					overrideConfigFile: getFixturePath(
						"eslint.config-with-ignores2.js",
					),
					cwd: getFixturePath(),
				});

				assert(!(await engine.isPathIgnored("undef.js")));
			});

			// https://github.com/eslint/eslint/issues/5547
			it("should return true for default ignores even if ignoring is disabled", async () => {
				const engine = new ESLint({
					flags,
					ignore: false,
					cwd: getFixturePath("cli-engine"),
				});

				assert(await engine.isPathIgnored("node_modules/foo.js"));
			});

			if (os.platform() === "win32") {
				it("should return true for a file on a different drive on Windows", async () => {
					const currentRoot = path.resolve("\\");
					const otherRoot = currentRoot === "A:\\" ? "B:\\" : "A:\\";
					const engine = new ESLint({
						flags,
						overrideConfigFile: true,
						cwd: currentRoot,
					});

					assert(
						!(await engine.isPathIgnored(`${currentRoot}file.js`)),
					);
					assert(await engine.isPathIgnored(`${otherRoot}file.js`));
					assert(
						await engine.isPathIgnored("//SERVER//share//file.js"),
					);
				});
			}

			describe("about the default ignore patterns", () => {
				it("should always apply default ignore patterns if ignore option is true", async () => {
					const cwd = getFixturePath("ignored-paths");
					const engine = new ESLint({ flags, cwd });

					assert(
						await engine.isPathIgnored(
							getFixturePath(
								"ignored-paths",
								"node_modules/package/file.js",
							),
						),
					);
					assert(
						await engine.isPathIgnored(
							getFixturePath(
								"ignored-paths",
								"subdir/node_modules/package/file.js",
							),
						),
					);
				});

				it("should still apply default ignore patterns if ignore option is false", async () => {
					const cwd = getFixturePath("ignored-paths");
					const engine = new ESLint({ flags, ignore: false, cwd });

					assert(
						await engine.isPathIgnored(
							getFixturePath(
								"ignored-paths",
								"node_modules/package/file.js",
							),
						),
					);
					assert(
						await engine.isPathIgnored(
							getFixturePath(
								"ignored-paths",
								"subdir/node_modules/package/file.js",
							),
						),
					);
				});

				it("should allow subfolders of defaultPatterns to be unignored by ignorePattern constructor option", async () => {
					const cwd = getFixturePath("ignored-paths");
					const engine = new ESLint({
						flags,
						cwd,
						overrideConfigFile: true,
						ignorePatterns: [
							"!node_modules/",
							"node_modules/*",
							"!node_modules/package/",
						],
					});

					const result = await engine.isPathIgnored(
						getFixturePath(
							"ignored-paths",
							"node_modules",
							"package",
							"file.js",
						),
					);

					assert(!result, "File should not be ignored");
				});

				it("should allow subfolders of defaultPatterns to be unignored by ignores in overrideConfig", async () => {
					const cwd = getFixturePath("ignored-paths");
					const engine = new ESLint({
						flags,
						cwd,
						overrideConfigFile: true,
						overrideConfig: {
							ignores: [
								"!node_modules/",
								"node_modules/*",
								"!node_modules/package/",
							],
						},
					});

					assert(
						!(await engine.isPathIgnored(
							getFixturePath(
								"ignored-paths",
								"node_modules",
								"package",
								"file.js",
							),
						)),
					);
				});

				it("should ignore .git directory", async () => {
					const cwd = getFixturePath("ignored-paths");
					const engine = new ESLint({ flags, cwd });

					assert(
						await engine.isPathIgnored(
							getFixturePath("ignored-paths", ".git/bar"),
						),
					);
				});

				it("should still ignore .git directory when ignore option disabled", async () => {
					const cwd = getFixturePath("ignored-paths");
					const engine = new ESLint({ flags, ignore: false, cwd });

					assert(
						await engine.isPathIgnored(
							getFixturePath("ignored-paths", ".git/bar"),
						),
					);
				});

				it("should not ignore absolute paths containing '..'", async () => {
					const cwd = getFixturePath("ignored-paths");
					const engine = new ESLint({ flags, cwd });

					assert(
						!(await engine.isPathIgnored(
							`${getFixturePath("ignored-paths", "foo")}/../unignored.js`,
						)),
					);
				});

				it("should ignore /node_modules/ relative to cwd without any configured ignore patterns", async () => {
					const cwd = getFixturePath(
						"ignored-paths",
						"no-ignore-file",
					);
					const engine = new ESLint({ flags, cwd });

					assert(
						await engine.isPathIgnored(
							getFixturePath(
								"ignored-paths",
								"no-ignore-file",
								"node_modules",
								"existing.js",
							),
						),
					);
					assert(
						await engine.isPathIgnored(
							getFixturePath(
								"ignored-paths",
								"no-ignore-file",
								"foo",
								"node_modules",
								"existing.js",
							),
						),
					);
				});

				it("should not inadvertently ignore all files in parent directories", async () => {
					const engine = new ESLint({
						flags,
						cwd: getFixturePath("ignored-paths", "no-ignore-file"),
					});

					assert(
						!(await engine.isPathIgnored(
							getFixturePath("ignored-paths", "undef.js"),
						)),
					);
				});
			});

			describe("with ignorePatterns option", () => {
				it("should accept a string for options.ignorePatterns", async () => {
					const cwd = getFixturePath(
						"ignored-paths",
						"ignore-pattern",
					);
					const engine = new ESLint({
						flags,
						ignorePatterns: ["ignore-me.txt"],
						cwd,
					});

					assert(await engine.isPathIgnored("ignore-me.txt"));
				});

				it("should accept an array for options.ignorePattern", async () => {
					const engine = new ESLint({
						flags,
						ignorePatterns: ["a.js", "b.js"],
						overrideConfigFile: true,
					});

					assert(
						await engine.isPathIgnored("a.js"),
						"a.js should be ignored",
					);
					assert(
						await engine.isPathIgnored("b.js"),
						"b.js should be ignored",
					);
					assert(
						!(await engine.isPathIgnored("c.js")),
						"c.js should not be ignored",
					);
				});

				it("should interpret ignorePatterns as relative to cwd", async () => {
					const cwd = getFixturePath("ignored-paths", "subdir");
					const engine = new ESLint({
						flags,
						ignorePatterns: ["undef.js"],
						cwd, // using ../../eslint.config.js
					});

					assert(
						await engine.isPathIgnored(path.join(cwd, "undef.js")),
					);
				});

				it("should return true for files which match an ignorePattern even if they do not exist on the filesystem", async () => {
					const cwd = getFixturePath("ignored-paths");
					const engine = new ESLint({
						flags,
						ignorePatterns: ["not-a-file"],
						cwd,
					});

					assert(
						await engine.isPathIgnored(
							getFixturePath("ignored-paths", "not-a-file"),
						),
					);
				});

				it("should return true for file matching an ignore pattern exactly", async () => {
					const cwd = getFixturePath("ignored-paths");
					const engine = new ESLint({
						flags,
						ignorePatterns: ["undef.js"],
						cwd,
						overrideConfigFile: true,
					});

					assert(
						await engine.isPathIgnored(
							getFixturePath("ignored-paths", "undef.js"),
						),
					);
				});

				it("should return false for file in subfolder of cwd matching an ignore pattern with a base filename", async () => {
					const cwd = getFixturePath("ignored-paths");
					const filePath = getFixturePath(
						"ignored-paths",
						"subdir",
						"undef.js",
					);
					const engine = new ESLint({
						flags,
						ignorePatterns: ["undef.js"],
						overrideConfigFile: true,
						cwd,
					});

					assert(!(await engine.isPathIgnored(filePath)));
				});

				it("should return true for file matching a child of an ignore pattern", async () => {
					const cwd = getFixturePath("ignored-paths");
					const engine = new ESLint({
						flags,
						ignorePatterns: ["ignore-pattern"],
						cwd,
					});

					assert(
						await engine.isPathIgnored(
							getFixturePath(
								"ignored-paths",
								"ignore-pattern",
								"ignore-me.txt",
							),
						),
					);
				});

				it("should return true for file matching a grandchild of a directory when the pattern is directory/**", async () => {
					const cwd = getFixturePath("ignored-paths");
					const engine = new ESLint({
						flags,
						ignorePatterns: ["ignore-pattern/**"],
						cwd,
					});

					assert(
						await engine.isPathIgnored(
							getFixturePath(
								"ignored-paths",
								"ignore-pattern",
								"subdir",
								"ignore-me.js",
							),
						),
					);
				});

				it("should return false for file not matching any ignore pattern", async () => {
					const cwd = getFixturePath("ignored-paths");
					const engine = new ESLint({
						flags,
						ignorePatterns: ["failing.js"],
						cwd,
					});

					assert(
						!(await engine.isPathIgnored(
							getFixturePath("ignored-paths", "unignored.js"),
						)),
					);
				});

				it("two globstar '**' ignore pattern should ignore files in nested directories", async () => {
					const cwd = getFixturePath("ignored-paths");
					const engine = new ESLint({
						flags,
						overrideConfigFile: true,
						ignorePatterns: ["**/*.js"],
						cwd,
					});

					assert(
						await engine.isPathIgnored(
							getFixturePath("ignored-paths", "foo.js"),
						),
						"foo.js should be ignored",
					);
					assert(
						await engine.isPathIgnored(
							getFixturePath("ignored-paths", "foo/bar.js"),
						),
						"foo/bar.js should be ignored",
					);
					assert(
						await engine.isPathIgnored(
							getFixturePath("ignored-paths", "foo/bar/baz.js"),
						),
						"foo/bar/baz.js",
					);
					assert(
						!(await engine.isPathIgnored(
							getFixturePath("ignored-paths", "foo.cjs"),
						)),
						"foo.cjs should not be ignored",
					);
					assert(
						!(await engine.isPathIgnored(
							getFixturePath("ignored-paths", "foo/bar.cjs"),
						)),
						"foo/bar.cjs should not be ignored",
					);
					assert(
						!(await engine.isPathIgnored(
							getFixturePath("ignored-paths", "foo/bar/baz.cjs"),
						)),
						"foo/bar/baz.cjs should not be ignored",
					);
				});
			});

			describe("with config ignores ignorePatterns option", () => {
				it("should return false for ignored file when unignored with ignore pattern", async () => {
					const cwd = getFixturePath("ignored-paths");
					const engine = new ESLint({
						flags,
						overrideConfigFile: getFixturePath(
							"eslint.config-with-ignores2.js",
						),
						ignorePatterns: ["!undef.js"],
						cwd,
					});

					assert(
						!(await engine.isPathIgnored(
							getFixturePath("ignored-paths", "undef.js"),
						)),
					);
				});
			});

			it("should throw if non-string value is given to 'filePath' parameter", async () => {
				const eslint = new ESLint({ flags });

				await assert.rejects(
					() => eslint.isPathIgnored(null),
					/'filePath' must be a non-empty string/u,
				);
			});
		});

		describe("loadFormatter()", () => {
			it("should return a formatter object when a bundled formatter is requested", async () => {
				const engine = new ESLint({ flags });
				const formatter = await engine.loadFormatter("json");

				assert.strictEqual(typeof formatter, "object");
				assert.strictEqual(typeof formatter.format, "function");
			});

			it("should return a formatter object when no argument is passed", async () => {
				const engine = new ESLint({ flags });
				const formatter = await engine.loadFormatter();

				assert.strictEqual(typeof formatter, "object");
				assert.strictEqual(typeof formatter.format, "function");
			});

			it("should return a formatter object when a custom formatter is requested", async () => {
				const engine = new ESLint({ flags });
				const formatter = await engine.loadFormatter(
					getFixturePath("formatters", "simple.js"),
				);

				assert.strictEqual(typeof formatter, "object");
				assert.strictEqual(typeof formatter.format, "function");
			});

			it("should return a formatter object when a custom formatter is requested, also if the path has backslashes", async () => {
				const engine = new ESLint({
					flags,
					cwd: path.join(fixtureDir, ".."),
				});
				const formatter = await engine.loadFormatter(
					".\\fixtures\\formatters\\simple.js",
				);

				assert.strictEqual(typeof formatter, "object");
				assert.strictEqual(typeof formatter.format, "function");
			});

			it("should return a formatter object when a formatter prefixed with eslint-formatter is requested", async () => {
				const engine = new ESLint({
					flags,
					cwd: getFixturePath("cli-engine"),
				});
				const formatter = await engine.loadFormatter("bar");

				assert.strictEqual(typeof formatter, "object");
				assert.strictEqual(typeof formatter.format, "function");
			});

			it("should return a formatter object when a formatter is requested, also when the eslint-formatter prefix is included in the format argument", async () => {
				const engine = new ESLint({
					flags,
					cwd: getFixturePath("cli-engine"),
				});
				const formatter = await engine.loadFormatter(
					"eslint-formatter-bar",
				);

				assert.strictEqual(typeof formatter, "object");
				assert.strictEqual(typeof formatter.format, "function");
			});

			it("should return a formatter object when a formatter is requested within a scoped npm package", async () => {
				const engine = new ESLint({
					flags,
					cwd: getFixturePath("cli-engine"),
				});
				const formatter =
					await engine.loadFormatter("@somenamespace/foo");

				assert.strictEqual(typeof formatter, "object");
				assert.strictEqual(typeof formatter.format, "function");
			});

			it("should return a formatter object when a formatter is requested within a scoped npm package, also when the eslint-formatter prefix is included in the format argument", async () => {
				const engine = new ESLint({
					flags,
					cwd: getFixturePath("cli-engine"),
				});
				const formatter = await engine.loadFormatter(
					"@somenamespace/eslint-formatter-foo",
				);

				assert.strictEqual(typeof formatter, "object");
				assert.strictEqual(typeof formatter.format, "function");
			});

			it("should throw if a custom formatter doesn't exist", async () => {
				const engine = new ESLint({ flags });
				const formatterPath = getFixturePath(
					"formatters",
					"doesntexist.js",
				);
				const fullFormatterPath = path.resolve(formatterPath);

				await assert.rejects(
					async () => {
						await engine.loadFormatter(formatterPath);
					},
					new RegExp(
						escapeStringRegExp(
							`There was a problem loading formatter: ${fullFormatterPath}\nError: Cannot find module '${fullFormatterPath}'`,
						),
						"u",
					),
				);
			});

			it("should throw if a built-in formatter doesn't exist", async () => {
				const engine = new ESLint({ flags });
				const fullFormatterPath = path.resolve(
					__dirname,
					"../../../lib/cli-engine/formatters/special",
				);

				await assert.rejects(
					async () => {
						await engine.loadFormatter("special");
					},
					new RegExp(
						escapeStringRegExp(
							`There was a problem loading formatter: ${fullFormatterPath}.js\nError: Cannot find module '${fullFormatterPath}.js'`,
						),
						"u",
					),
				);
			});

			it("should throw if the required formatter exists but has an error", async () => {
				const engine = new ESLint({ flags });
				const formatterPath = getFixturePath("formatters", "broken.js");

				await assert.rejects(
					async () => {
						await engine.loadFormatter(formatterPath);

						// for some reason, the error here contains multiple "there was a problem loading formatter" lines, so omitting
					},
					new RegExp(
						escapeStringRegExp(
							"Error: Cannot find module 'this-module-does-not-exist'",
						),
						"u",
					),
				);
			});

			it("should throw if a non-string formatter name is passed", async () => {
				const engine = new ESLint({ flags });

				await assert.rejects(async () => {
					await engine.loadFormatter(5);
				}, /'name' must be a string/u);
			});
		});

		describe("getErrorResults()", () => {
			it("should report 5 error messages when looking for errors only", async () => {
				process.chdir(originalDir);
				const engine = new ESLint({
					flags,
					overrideConfigFile: true,
					overrideConfig: {
						rules: {
							quotes: "error",
							"no-var": "error",
							"eol-last": "error",
							"no-unused-vars": "error",
						},
					},
				});
				const results = await engine.lintText("var foo = 'bar';");
				const errorResults = ESLint.getErrorResults(results);

				assert.strictEqual(
					errorResults[0].messages.length,
					4,
					"messages.length is wrong",
				);
				assert.strictEqual(
					errorResults[0].errorCount,
					4,
					"errorCount is wrong",
				);
				assert.strictEqual(
					errorResults[0].fixableErrorCount,
					3,
					"fixableErrorCount is wrong",
				);
				assert.strictEqual(
					errorResults[0].fixableWarningCount,
					0,
					"fixableWarningCount is wrong",
				);
				assert.strictEqual(
					errorResults[0].messages[0].ruleId,
					"no-var",
				);
				assert.strictEqual(errorResults[0].messages[0].severity, 2);
				assert.strictEqual(
					errorResults[0].messages[1].ruleId,
					"no-unused-vars",
				);
				assert.strictEqual(errorResults[0].messages[1].severity, 2);
				assert.strictEqual(
					errorResults[0].messages[2].ruleId,
					"quotes",
				);
				assert.strictEqual(errorResults[0].messages[2].severity, 2);
				assert.strictEqual(
					errorResults[0].messages[3].ruleId,
					"eol-last",
				);
				assert.strictEqual(errorResults[0].messages[3].severity, 2);
			});

			it("should not mutate passed report parameter", async () => {
				process.chdir(originalDir);
				const engine = new ESLint({
					flags,
					overrideConfigFile: true,
					overrideConfig: {
						rules: { quotes: [1, "double"] },
					},
				});
				const results = await engine.lintText("var foo = 'bar';");
				const reportResultsLength = results[0].messages.length;

				ESLint.getErrorResults(results);

				assert.strictEqual(
					results[0].messages.length,
					reportResultsLength,
				);
			});

			it("should report a warningCount of 0 when looking for errors only", async () => {
				const engine = new ESLint({
					flags,
					overrideConfigFile: true,
					overrideConfig: {
						rules: {
							strict: ["error", "global"],
							quotes: "error",
							"no-var": "error",
							"eol-last": "error",
							"no-unused-vars": "error",
						},
					},
				});
				const lintResults = await engine.lintText("var foo = 'bar';");
				const errorResults = ESLint.getErrorResults(lintResults);

				assert.strictEqual(errorResults[0].warningCount, 0);
				assert.strictEqual(errorResults[0].fixableWarningCount, 0);
			});

			it("should return 0 error or warning messages even when the file has warnings", async () => {
				const engine = new ESLint({
					flags,
					overrideConfigFile: getFixturePath(
						"eslint.config-with-ignores.js",
					),
					cwd: path.join(fixtureDir, ".."),
				});
				const options = {
					filePath: "fixtures/passing.js",
					warnIgnored: true,
				};
				const results = await engine.lintText(
					"var bar = foo;",
					options,
				);
				const errorReport = ESLint.getErrorResults(results);

				assert.strictEqual(errorReport.length, 0);
				assert.strictEqual(results.length, 1);
				assert.strictEqual(results[0].errorCount, 0);
				assert.strictEqual(results[0].warningCount, 1);
			});

			it("should return source code of file in the `source` property", async () => {
				process.chdir(originalDir);
				const engine = new ESLint({
					flags,
					overrideConfigFile: true,
					overrideConfig: {
						rules: { quotes: [2, "double"] },
					},
				});
				const results = await engine.lintText("var foo = 'bar';");
				const errorResults = ESLint.getErrorResults(results);

				assert.strictEqual(errorResults[0].messages.length, 1);
				assert.strictEqual(errorResults[0].source, "var foo = 'bar';");
			});

			it("should contain `output` property after fixes", async () => {
				process.chdir(originalDir);
				const engine = new ESLint({
					flags,
					overrideConfigFile: true,
					fix: true,
					overrideConfig: {
						rules: {
							semi: 2,
							"no-console": 2,
						},
					},
				});
				const results = await engine.lintText("console.log('foo')");
				const errorResults = ESLint.getErrorResults(results);

				assert.strictEqual(errorResults[0].messages.length, 1);
				assert.strictEqual(
					errorResults[0].output,
					"console.log('foo');",
				);
			});
		});

		describe("findConfigFile()", () => {
			it("should return undefined when overrideConfigFile is true", async () => {
				const engine = new ESLint({
					flags,
					overrideConfigFile: true,
				});

				assert.strictEqual(await engine.findConfigFile(), void 0);
			});

			it("should return undefined when a config file isn't found", async () => {
				const engine = new ESLint({
					flags,
					cwd: path.resolve(__dirname, "../../../../"),
				});

				assert.strictEqual(await engine.findConfigFile(), void 0);
			});

			it("should return custom config file path when overrideConfigFile is a nonempty string", async () => {
				const engine = new ESLint({
					flags,
					overrideConfigFile: "my-config.js",
				});
				const configFilePath = path.resolve(
					__dirname,
					"../../../my-config.js",
				);

				assert.strictEqual(
					await engine.findConfigFile(),
					configFilePath,
				);
			});

			it("should return root level eslint.config.js when overrideConfigFile is null", async () => {
				const engine = new ESLint({
					flags,
					overrideConfigFile: null,
				});
				const configFilePath = path.resolve(
					__dirname,
					"../../../eslint.config.js",
				);

				assert.strictEqual(
					await engine.findConfigFile(),
					configFilePath,
				);
			});

			it("should return root level eslint.config.js when overrideConfigFile is not specified", async () => {
				const engine = new ESLint({ flags });
				const configFilePath = path.resolve(
					__dirname,
					"../../../eslint.config.js",
				);

				assert.strictEqual(
					await engine.findConfigFile(),
					configFilePath,
				);
			});
		});

		describe("Use stats option", () => {
			/**
			 * Check if the given number is a number.
			 * @param {number} n The number to check.
			 * @returns {boolean} `true` if the number is a number, `false` otherwise.
			 */
			function isNumber(n) {
				return typeof n === "number" && !Number.isNaN(n);
			}

			it("should report stats", async () => {
				const engine = new ESLint({
					flags,
					overrideConfigFile: true,
					overrideConfig: {
						rules: {
							"no-regex-spaces": "error",
						},
					},
					cwd: getFixturePath("stats-example"),
					stats: true,
				});
				const results = await engine.lintFiles(["file-to-fix.js"]);

				assert.strictEqual(results[0].stats.fixPasses, 0);
				assert.strictEqual(results[0].stats.times.passes.length, 1);
				assert.strictEqual(
					isNumber(results[0].stats.times.passes[0].parse.total),
					true,
				);
				assert.strictEqual(
					isNumber(
						results[0].stats.times.passes[0].rules[
							"no-regex-spaces"
						].total,
					),
					true,
				);
				assert.strictEqual(
					isNumber(
						results[0].stats.times.passes[0].rules["wrap-regex"]
							.total,
					),
					true,
				);
				assert.strictEqual(
					results[0].stats.times.passes[0].fix.total,
					0,
				);
				assert.strictEqual(
					isNumber(results[0].stats.times.passes[0].total),
					true,
				);
			});

			it("should report stats with fix", async () => {
				const engine = new ESLint({
					flags,
					overrideConfigFile: true,
					overrideConfig: {
						rules: {
							"no-regex-spaces": "error",
						},
					},
					cwd: getFixturePath("stats-example"),
					fix: true,
					stats: true,
				});
				const results = await engine.lintFiles(["file-to-fix.js"]);

				assert.strictEqual(results[0].stats.fixPasses, 2);
				assert.strictEqual(results[0].stats.times.passes.length, 3);
				assert.strictEqual(
					isNumber(results[0].stats.times.passes[0].parse.total),
					true,
				);
				assert.strictEqual(
					isNumber(results[0].stats.times.passes[1].parse.total),
					true,
				);
				assert.strictEqual(
					isNumber(results[0].stats.times.passes[2].parse.total),
					true,
				);
				assert.strictEqual(
					isNumber(
						results[0].stats.times.passes[0].rules[
							"no-regex-spaces"
						].total,
					),
					true,
				);
				assert.strictEqual(
					isNumber(
						results[0].stats.times.passes[0].rules["wrap-regex"]
							.total,
					),
					true,
				);
				assert.strictEqual(
					isNumber(
						results[0].stats.times.passes[1].rules[
							"no-regex-spaces"
						].total,
					),
					true,
				);
				assert.strictEqual(
					isNumber(
						results[0].stats.times.passes[1].rules["wrap-regex"]
							.total,
					),
					true,
				);
				assert.strictEqual(
					isNumber(
						results[0].stats.times.passes[2].rules[
							"no-regex-spaces"
						].total,
					),
					true,
				);
				assert.strictEqual(
					isNumber(
						results[0].stats.times.passes[2].rules["wrap-regex"]
							.total,
					),
					true,
				);
				assert.strictEqual(
					isNumber(results[0].stats.times.passes[0].fix.total),
					true,
				);
				assert.strictEqual(
					isNumber(results[0].stats.times.passes[1].fix.total),
					true,
				);
				assert.strictEqual(
					results[0].stats.times.passes[2].fix.total,
					0,
				);
				assert.strictEqual(
					isNumber(results[0].stats.times.passes[0].total),
					true,
				);
				assert.strictEqual(
					isNumber(results[0].stats.times.passes[1].total),
					true,
				);
				assert.strictEqual(
					isNumber(results[0].stats.times.passes[2].total),
					true,
				);
			});
		});

		describe("getRulesMetaForResults()", () => {
			it("should throw an error when this instance did not lint any files", async () => {
				const engine = new ESLint({
					flags,
					overrideConfigFile: true,
				});

				assert.throws(
					() => {
						engine.getRulesMetaForResults([
							{
								filePath: "path/to/file.js",
								messages: [
									{
										ruleId: "curly",
										severity: 2,
										message:
											"Expected { after 'if' condition.",
										line: 2,
										column: 1,
										nodeType: "IfStatement",
									},
									{
										ruleId: "no-process-exit",
										severity: 2,
										message:
											"Don't use process.exit(); throw an error instead.",
										line: 3,
										column: 1,
										nodeType: "CallExpression",
									},
								],
								suppressedMessages: [],
								errorCount: 2,
								warningCount: 0,
								fatalErrorCount: 0,
								fixableErrorCount: 0,
								fixableWarningCount: 0,
								source: "var err = doStuff();\nif (err) console.log('failed tests: ' + err);\nprocess.exit(1);\n",
							},
						]);
					},
					{
						constructor: TypeError,
						message:
							"Results object was not created from this ESLint instance.",
					},
				);
			});

			it("should throw an error when results were created from a different instance", async () => {
				const engine1 = new ESLint({
					flags,
					overrideConfigFile: true,
					cwd: path.join(fixtureDir, "foo"),
					overrideConfig: {
						rules: {
							semi: 2,
						},
					},
				});
				const engine2 = new ESLint({
					flags,
					overrideConfigFile: true,
					cwd: path.join(fixtureDir, "bar"),
					overrideConfig: {
						rules: {
							semi: 2,
						},
					},
				});

				const results1 = await engine1.lintText("1", {
					filePath: "file.js",
				});
				const results2 = await engine2.lintText("2", {
					filePath: "file.js",
				});

				engine1.getRulesMetaForResults(results1); // should not throw an error
				assert.throws(
					() => {
						engine1.getRulesMetaForResults(results2);
					},
					{
						constructor: TypeError,
						message:
							"Results object was not created from this ESLint instance.",
					},
				);
			});

			it("should treat a result without `filePath` as if the file was located in `cwd`", async () => {
				const engine = new ESLint({
					flags,
					overrideConfigFile: true,
					cwd: path.join(fixtureDir, "foo", "bar"),
					ignorePatterns: ["*/**"], // ignore all subdirectories of `cwd`
					overrideConfig: {
						rules: {
							eqeqeq: "warn",
						},
					},
				});

				const results = await engine.lintText("a==b");
				const rulesMeta = engine.getRulesMetaForResults(results);

				assert.deepStrictEqual(
					rulesMeta.eqeqeq,
					coreRules.get("eqeqeq").meta,
				);
			});

			it("should not throw an error if a result without `filePath` contains an ignored file warning", async () => {
				const engine = new ESLint({
					flags,
					overrideConfigFile: true,
					cwd: path.join(fixtureDir, "foo", "bar"),
					ignorePatterns: ["**"],
				});

				const results = await engine.lintText("", {
					warnIgnored: true,
				});
				const rulesMeta = engine.getRulesMetaForResults(results);

				assert.deepStrictEqual(rulesMeta, {});
			});

			it("should not throw an error if results contain linted files and one ignored file", async () => {
				const engine = new ESLint({
					flags,
					overrideConfigFile: true,
					cwd: getFixturePath(),
					ignorePatterns: ["passing*"],
					overrideConfig: {
						rules: {
							"no-undef": 2,
							semi: 1,
						},
					},
				});

				const results = await engine.lintFiles([
					"missing-semicolon.js",
					"passing.js",
					"undef.js",
				]);

				assert(
					results.some(({ messages }) =>
						messages.some(
							({ message, ruleId }) =>
								!ruleId && message.startsWith("File ignored"),
						),
					),
					"At least one file should be ignored but none is.",
				);

				const rulesMeta = engine.getRulesMetaForResults(results);

				assert.deepStrictEqual(
					rulesMeta["no-undef"],
					coreRules.get("no-undef").meta,
				);
				assert.deepStrictEqual(
					rulesMeta.semi,
					coreRules.get("semi").meta,
				);
			});

			it("should return empty object when there are no linting errors", async () => {
				const engine = new ESLint({
					flags,
					overrideConfigFile: true,
				});

				const rulesMeta = engine.getRulesMetaForResults([]);

				assert.deepStrictEqual(rulesMeta, {});
			});

			it("should return one rule meta when there is a linting error", async () => {
				const engine = new ESLint({
					flags,
					overrideConfigFile: true,
					overrideConfig: {
						rules: {
							semi: 2,
						},
					},
				});

				const results = await engine.lintText("a", {
					filePath: "foo.js",
				});
				const rulesMeta = engine.getRulesMetaForResults(results);

				assert.strictEqual(Object.keys(rulesMeta).length, 1);
				assert.strictEqual(rulesMeta.semi, coreRules.get("semi").meta);
			});

			it("should return one rule meta when there is a suppressed linting error", async () => {
				const engine = new ESLint({
					flags,
					overrideConfigFile: true,
					overrideConfig: {
						rules: {
							semi: 2,
						},
					},
				});

				const results = await engine.lintText(
					"a // eslint-disable-line semi",
				);
				const rulesMeta = engine.getRulesMetaForResults(results);

				assert.strictEqual(Object.keys(rulesMeta).length, 1);
				assert.strictEqual(rulesMeta.semi, coreRules.get("semi").meta);
			});

			it("should return multiple rule meta when there are multiple linting errors", async () => {
				const engine = new ESLint({
					flags,
					overrideConfigFile: true,
					overrideConfig: {
						rules: {
							semi: 2,
							quotes: [2, "double"],
						},
					},
				});

				const results = await engine.lintText("'a'");
				const rulesMeta = engine.getRulesMetaForResults(results);

				assert.strictEqual(rulesMeta.semi, coreRules.get("semi").meta);
				assert.strictEqual(
					rulesMeta.quotes,
					coreRules.get("quotes").meta,
				);
			});

			it("should return multiple rule meta when there are multiple linting errors from a plugin", async () => {
				const customPlugin = {
					rules: {
						"no-var": require("../../../lib/rules/no-var"),
					},
				};
				const engine = new ESLint({
					flags,
					overrideConfigFile: true,
					overrideConfig: {
						plugins: {
							"custom-plugin": customPlugin,
						},
						rules: {
							"custom-plugin/no-var": 2,
							semi: 2,
							quotes: [2, "double"],
						},
					},
				});

				const results = await engine.lintText(
					"var foo = 0; var bar = '1'",
				);
				const rulesMeta = engine.getRulesMetaForResults(results);

				assert.strictEqual(rulesMeta.semi, coreRules.get("semi").meta);
				assert.strictEqual(
					rulesMeta.quotes,
					coreRules.get("quotes").meta,
				);
				assert.strictEqual(
					rulesMeta["custom-plugin/no-var"],
					customPlugin.rules["no-var"].meta,
				);
			});

			it("should ignore messages not related to a rule", async () => {
				const engine = new ESLint({
					flags,
					overrideConfigFile: true,
					ignorePatterns: ["ignored.js"],
					overrideConfig: {
						rules: {
							"no-var": "warn",
						},
						linterOptions: {
							reportUnusedDisableDirectives: "warn",
						},
					},
				});

				{
					const results = await engine.lintText("syntax error");
					const rulesMeta = engine.getRulesMetaForResults(results);

					assert.deepStrictEqual(rulesMeta, {});
				}
				{
					const results = await engine.lintText(
						"// eslint-disable-line no-var",
					);
					const rulesMeta = engine.getRulesMetaForResults(results);

					assert.deepStrictEqual(rulesMeta, {});
				}
				{
					const results = await engine.lintText("", {
						filePath: "ignored.js",
						warnIgnored: true,
					});
					const rulesMeta = engine.getRulesMetaForResults(results);

					assert.deepStrictEqual(rulesMeta, {});
				}
			});

			it("should return a non-empty value if some of the messages are related to a rule", async () => {
				const engine = new ESLint({
					flags,
					overrideConfigFile: true,
					overrideConfig: {
						rules: { "no-var": "warn" },
						linterOptions: {
							reportUnusedDisableDirectives: "warn",
						},
					},
				});

				const results = await engine.lintText(
					"// eslint-disable-line no-var\nvar foo;",
				);
				const rulesMeta = engine.getRulesMetaForResults(results);

				assert.deepStrictEqual(rulesMeta, {
					"no-var": coreRules.get("no-var").meta,
				});
			});

			it("should return empty object if all messages are related to unknown rules", async () => {
				const engine = new ESLint({
					flags,
					overrideConfigFile: true,
				});

				const results = await engine.lintText(
					"// eslint-disable-line foo, bar/baz, bar/baz/qux",
				);

				assert.strictEqual(results[0].messages.length, 3);
				assert.strictEqual(results[0].messages[0].ruleId, "foo");
				assert.strictEqual(results[0].messages[1].ruleId, "bar/baz");
				assert.strictEqual(
					results[0].messages[2].ruleId,
					"bar/baz/qux",
				);

				const rulesMeta = engine.getRulesMetaForResults(results);

				assert.strictEqual(Object.keys(rulesMeta).length, 0);
			});

			it("should return object with meta of known rules if some messages are related to unknown rules", async () => {
				const engine = new ESLint({
					flags,
					overrideConfigFile: true,
					overrideConfig: { rules: { "no-var": "warn" } },
				});

				const results = await engine.lintText(
					"// eslint-disable-line foo, bar/baz, bar/baz/qux\nvar x;",
				);

				assert.strictEqual(results[0].messages.length, 4);
				assert.strictEqual(results[0].messages[0].ruleId, "foo");
				assert.strictEqual(results[0].messages[1].ruleId, "bar/baz");
				assert.strictEqual(
					results[0].messages[2].ruleId,
					"bar/baz/qux",
				);
				assert.strictEqual(results[0].messages[3].ruleId, "no-var");

				const rulesMeta = engine.getRulesMetaForResults(results);

				assert.deepStrictEqual(rulesMeta, {
					"no-var": coreRules.get("no-var").meta,
				});
			});
		});

		describe("outputFixes()", () => {
			afterEach(() => {
				sinon.verifyAndRestore();
			});

			it("should call fs.writeFile() for each result with output", async () => {
				const spy = sinon.spy(() => Promise.resolve());
				const { ESLint: localESLint } = proxyquire(
					"../../../lib/eslint/eslint",
					{
						"node:fs/promises": {
							writeFile: spy,
						},
					},
				);

				const results = [
					{
						filePath: path.resolve("foo.js"),
						output: "bar",
					},
					{
						filePath: path.resolve("bar.js"),
						output: "baz",
					},
				];

				await localESLint.outputFixes(results);

				assert.strictEqual(spy.callCount, 2);
				assert(
					spy.firstCall.calledWithExactly(
						path.resolve("foo.js"),
						"bar",
					),
					"First call was incorrect.",
				);
				assert(
					spy.secondCall.calledWithExactly(
						path.resolve("bar.js"),
						"baz",
					),
					"Second call was incorrect.",
				);
			});

			it("should call fs.writeFile() for each result with output and not at all for a result without output", async () => {
				const spy = sinon.spy(() => Promise.resolve());
				const { ESLint: localESLint } = proxyquire(
					"../../../lib/eslint/eslint",
					{
						"node:fs/promises": {
							writeFile: spy,
						},
					},
				);

				const results = [
					{
						filePath: path.resolve("foo.js"),
						output: "bar",
					},
					{
						filePath: path.resolve("abc.js"),
					},
					{
						filePath: path.resolve("bar.js"),
						output: "baz",
					},
				];

				await localESLint.outputFixes(results);

				assert.strictEqual(spy.callCount, 2, "Call count was wrong");
				assert(
					spy.firstCall.calledWithExactly(
						path.resolve("foo.js"),
						"bar",
					),
					"First call was incorrect.",
				);
				assert(
					spy.secondCall.calledWithExactly(
						path.resolve("bar.js"),
						"baz",
					),
					"Second call was incorrect.",
				);
			});

			it("should throw if non object array is given to 'results' parameter", async () => {
				await assert.rejects(
					() => ESLint.outputFixes(null),
					/'results' must be an array/u,
				);
				await assert.rejects(
					() => ESLint.outputFixes([null]),
					/'results' must include only objects/u,
				);
			});
		});

		describe("when evaluating code with comments to change config when allowInlineConfig is disabled", () => {
			it("should report a violation for disabling rules", async () => {
				const code = [
					"alert('test'); // eslint-disable-line no-alert",
				].join("\n");
				const config = {
					flags,
					ignore: true,
					overrideConfigFile: true,
					allowInlineConfig: false,
					overrideConfig: {
						rules: {
							"eol-last": 0,
							"no-alert": 1,
							"no-trailing-spaces": 0,
							strict: 0,
							quotes: 0,
						},
					},
				};
				const eslintCLI = new ESLint(config);
				const results = await eslintCLI.lintText(code);
				const messages = results[0].messages;

				assert.strictEqual(messages.length, 1);
				assert.strictEqual(messages[0].ruleId, "no-alert");
				assert.strictEqual(results[0].suppressedMessages.length, 0);
			});

			it("should not report a violation by default", async () => {
				const code = [
					"alert('test'); // eslint-disable-line no-alert",
				].join("\n");
				const config = {
					flags,
					ignore: true,
					overrideConfigFile: true,
					allowInlineConfig: true,
					overrideConfig: {
						rules: {
							"eol-last": 0,
							"no-alert": 1,
							"no-trailing-spaces": 0,
							strict: 0,
							quotes: 0,
						},
					},
				};
				const eslintCLI = new ESLint(config);
				const results = await eslintCLI.lintText(code);
				const messages = results[0].messages;

				assert.strictEqual(messages.length, 0);
				assert.strictEqual(results[0].suppressedMessages.length, 1);
				assert.strictEqual(
					results[0].suppressedMessages[0].ruleId,
					"no-alert",
				);
			});
		});

		describe("when evaluating code when reportUnusedDisableDirectives is enabled", () => {
			it("should report problems for unused eslint-disable directives", async () => {
				const eslint = new ESLint({
					flags,
					overrideConfigFile: true,
					overrideConfig: {
						linterOptions: {
							reportUnusedDisableDirectives: "error",
						},
					},
				});

				assert.deepStrictEqual(
					await eslint.lintText("/* eslint-disable */"),
					[
						{
							filePath: "<text>",
							messages: [
								{
									ruleId: null,
									message:
										"Unused eslint-disable directive (no problems were reported).",
									line: 1,
									column: 1,
									fix: {
										range: [0, 20],
										text: " ",
									},
									severity: 2,
									nodeType: null,
								},
							],
							suppressedMessages: [],
							errorCount: 1,
							warningCount: 0,
							fatalErrorCount: 0,
							fixableErrorCount: 1,
							fixableWarningCount: 0,
							source: "/* eslint-disable */",
							usedDeprecatedRules: [],
						},
					],
				);
			});
		});

		describe("when retrieving version number", () => {
			it("should return current version number", () => {
				const eslintCLI = require("../../../lib/eslint/eslint").ESLint;
				const version = eslintCLI.version;

				assert.strictEqual(typeof version, "string");
				assert(parseInt(version[0], 10) >= 3);
			});
		});

		describe("mutability", () => {
			describe("rules", () => {
				it("Loading rules in one instance doesn't mutate to another instance", async () => {
					const filePath = getFixturePath("single-quoted.js");
					const engine1 = new ESLint({
						flags,
						cwd: path.join(fixtureDir, ".."),
						overrideConfigFile: true,
						overrideConfig: {
							plugins: {
								example: {
									rules: {
										"example-rule"() {
											return {};
										},
									},
								},
							},
							rules: { "example/example-rule": 1 },
						},
					});
					const engine2 = new ESLint({
						flags,
						cwd: path.join(fixtureDir, ".."),
						overrideConfigFile: true,
					});
					const fileConfig1 =
						await engine1.calculateConfigForFile(filePath);
					const fileConfig2 =
						await engine2.calculateConfigForFile(filePath);

					// plugin
					assert.deepStrictEqual(
						fileConfig1.rules["example/example-rule"],
						[1],
						"example is present for engine 1",
					);
					assert.strictEqual(
						fileConfig2.rules,
						void 0,
						"example is not present for engine 2",
					);
				});
			});
		});

		describe("configs with 'ignores' and without 'files'", () => {
			// https://github.com/eslint/eslint/issues/17103
			describe("config with ignores: ['error.js']", () => {
				const cwd = getFixturePath("config-with-ignores-without-files");
				const { prepare, cleanup, getPath } = createCustomTeardown({
					cwd,
					files: {
						"eslint.config.js": `module.exports = [
                            {
                                rules: {
                                    "no-unused-vars": "error",
                                },
                            },
                            {
                                ignores: ["error.js"],
                                rules: {
                                    "no-unused-vars": "warn",
                                },
                            },
                        ];`,
						"error.js": "let unusedVar;",
						"warn.js": "let unusedVar;",
					},
				});

				beforeEach(prepare);
				afterEach(cleanup);

				it("should apply to all files except for 'error.js'", async () => {
					const engine = new ESLint({
						flags,
						cwd,
					});

					const results = await engine.lintFiles("{error,warn}.js");

					assert.strictEqual(results.length, 2);

					const [errorResult, warnResult] = results;

					assert.strictEqual(
						errorResult.filePath,
						path.join(getPath(), "error.js"),
					);
					assert.strictEqual(errorResult.messages.length, 1);
					assert.strictEqual(
						errorResult.messages[0].ruleId,
						"no-unused-vars",
					);
					assert.strictEqual(errorResult.messages[0].severity, 2);

					assert.strictEqual(
						warnResult.filePath,
						path.join(getPath(), "warn.js"),
					);
					assert.strictEqual(warnResult.messages.length, 1);
					assert.strictEqual(
						warnResult.messages[0].ruleId,
						"no-unused-vars",
					);
					assert.strictEqual(warnResult.messages[0].severity, 1);
				});

				// https://github.com/eslint/eslint/issues/18261
				it("should apply to all files except for 'error.js' even with `ignore: false` option", async () => {
					const engine = new ESLint({
						flags,
						cwd,
						ignore: false,
					});

					const results = await engine.lintFiles("{error,warn}.js");

					assert.strictEqual(results.length, 2);

					const [errorResult, warnResult] = results;

					assert.strictEqual(
						errorResult.filePath,
						path.join(getPath(), "error.js"),
					);
					assert.strictEqual(errorResult.messages.length, 1);
					assert.strictEqual(
						errorResult.messages[0].ruleId,
						"no-unused-vars",
					);
					assert.strictEqual(errorResult.messages[0].severity, 2);

					assert.strictEqual(
						warnResult.filePath,
						path.join(getPath(), "warn.js"),
					);
					assert.strictEqual(warnResult.messages.length, 1);
					assert.strictEqual(
						warnResult.messages[0].ruleId,
						"no-unused-vars",
					);
					assert.strictEqual(warnResult.messages[0].severity, 1);
				});
			});

			describe("config with ignores: ['**/*.json']", () => {
				const cwd = getFixturePath("config-with-ignores-without-files");
				const { prepare, cleanup, getPath } = createCustomTeardown({
					cwd,
					files: {
						"eslint.config.js": `module.exports = [
                            {
                                rules: {
                                    "no-undef": "error",
                                },
                            },
                            {
                                ignores: ["**/*.json"],
                                rules: {
                                    "no-unused-vars": "error",
                                },
                            },
                        ];`,
						"foo.js": "",
						"foo.json": "",
					},
				});

				beforeEach(prepare);
				afterEach(cleanup);

				it("should not add json files as lint targets", async () => {
					const engine = new ESLint({
						flags,
						cwd,
					});

					const results = await engine.lintFiles("foo*");

					// should not lint `foo.json`
					assert.strictEqual(results.length, 1);
					assert.strictEqual(
						results[0].filePath,
						path.join(getPath(), "foo.js"),
					);
				});
			});
		});

		describe("with ignores config", () => {
			const root = getFixturePath("cli-engine/ignore-patterns");

			describe("ignores can add an ignore pattern ('foo.js').", () => {
				const { prepare, cleanup, getPath } = createCustomTeardown({
					cwd: root,
					files: {
						"eslint.config.js": `module.exports = {
                            ignores: ["**/foo.js"]
                        };`,
						"foo.js": "",
						"bar.js": "",
						"subdir/foo.js": "",
						"subdir/bar.js": "",
					},
				});

				beforeEach(prepare);
				afterEach(cleanup);

				it("'isPathIgnored()' should return 'true' for 'foo.js'.", async () => {
					const engine = new ESLint({ flags, cwd: getPath() });

					assert.strictEqual(
						await engine.isPathIgnored("foo.js"),
						true,
					);
					assert.strictEqual(
						await engine.isPathIgnored("subdir/foo.js"),
						true,
					);
				});

				it("'isPathIgnored()' should return 'false' for 'bar.js'.", async () => {
					const engine = new ESLint({ flags, cwd: getPath() });

					assert.strictEqual(
						await engine.isPathIgnored("bar.js"),
						false,
					);
					assert.strictEqual(
						await engine.isPathIgnored("subdir/bar.js"),
						false,
					);
				});

				it("'lintFiles()' should not verify 'foo.js'.", async () => {
					const engine = new ESLint({ flags, cwd: getPath() });
					const filePaths = (await engine.lintFiles("**/*.js"))
						.map(r => r.filePath)
						.sort();

					assert.deepStrictEqual(filePaths, [
						path.join(root, "bar.js"),
						path.join(root, "eslint.config.js"),
						path.join(root, "subdir/bar.js"),
					]);
				});
			});

			describe("ignores can add ignore patterns ('**/foo.js', '/bar.js').", () => {
				const { prepare, cleanup, getPath } = createCustomTeardown({
					cwd: root + Date.now(),
					files: {
						"eslint.config.js": `module.exports = {
                            ignores: ["**/foo.js", "bar.js"]
                        };`,
						"foo.js": "",
						"bar.js": "",
						"baz.js": "",
						"subdir/foo.js": "",
						"subdir/bar.js": "",
						"subdir/baz.js": "",
					},
				});

				beforeEach(prepare);
				afterEach(cleanup);

				it("'isPathIgnored()' should return 'true' for 'foo.js'.", async () => {
					const engine = new ESLint({ flags, cwd: getPath() });

					assert.strictEqual(
						await engine.isPathIgnored("foo.js"),
						true,
					);
					assert.strictEqual(
						await engine.isPathIgnored("subdir/foo.js"),
						true,
					);
				});

				it("'isPathIgnored()' should return 'true' for '/bar.js'.", async () => {
					const engine = new ESLint({ flags, cwd: getPath() });

					assert.strictEqual(
						await engine.isPathIgnored("bar.js"),
						true,
					);
					assert.strictEqual(
						await engine.isPathIgnored("subdir/bar.js"),
						false,
					);
				});

				it("'lintFiles()' should not verify 'foo.js' and '/bar.js'.", async () => {
					const engine = new ESLint({ flags, cwd: getPath() });
					const filePaths = (await engine.lintFiles("**/*.js"))
						.map(r => r.filePath)
						.sort();

					assert.deepStrictEqual(filePaths, [
						path.join(getPath(), "baz.js"),
						path.join(getPath(), "eslint.config.js"),
						path.join(getPath(), "subdir/bar.js"),
						path.join(getPath(), "subdir/baz.js"),
					]);
				});
			});

			describe("ignores can unignore '/node_modules/foo' with patterns ['!node_modules/', 'node_modules/*', '!node_modules/foo/'].", () => {
				const { prepare, cleanup, getPath } = createCustomTeardown({
					cwd: `${root}-unignores`,
					files: {
						"eslint.config.js": `module.exports = {
                            ignores: ["!node_modules/", "node_modules/*", "!node_modules/foo/"]
                        };`,
						"node_modules/foo/index.js": "",
						"node_modules/foo/.dot.js": "",
						"node_modules/bar/index.js": "",
						"foo.js": "",
					},
				});

				beforeEach(prepare);
				afterEach(cleanup);

				it("'isPathIgnored()' should return 'false' for 'node_modules/foo/index.js'.", async () => {
					const engine = new ESLint({ flags, cwd: getPath() });

					assert.strictEqual(
						await engine.isPathIgnored("node_modules/foo/index.js"),
						false,
					);
				});

				it("'isPathIgnored()' should return 'false' for 'node_modules/foo/.dot.js'.", async () => {
					const engine = new ESLint({ flags, cwd: getPath() });

					assert.strictEqual(
						await engine.isPathIgnored("node_modules/foo/.dot.js"),
						false,
					);
				});

				it("'isPathIgnored()' should return 'true' for 'node_modules/bar/index.js'.", async () => {
					const engine = new ESLint({ flags, cwd: getPath() });

					assert.strictEqual(
						await engine.isPathIgnored("node_modules/bar/index.js"),
						true,
					);
				});

				it("'lintFiles()' should verify 'node_modules/foo/index.js'.", async () => {
					const engine = new ESLint({ flags, cwd: getPath() });
					const filePaths = (await engine.lintFiles("**/*.js"))
						.map(r => r.filePath)
						.sort();

					assert.deepStrictEqual(filePaths, [
						path.join(getPath(), "eslint.config.js"),
						path.join(getPath(), "foo.js"),
						path.join(getPath(), "node_modules/foo/.dot.js"),
						path.join(getPath(), "node_modules/foo/index.js"),
					]);
				});
			});

			describe("ignores can unignore '/node_modules/foo' with patterns ['!node_modules/', 'node_modules/*', '!node_modules/foo/**'].", () => {
				const { prepare, cleanup, getPath } = createCustomTeardown({
					cwd: `${root}-unignores`,
					files: {
						"eslint.config.js": `module.exports = {
                            ignores: ["!node_modules/", "node_modules/*", "!node_modules/foo/**"]
                        };`,
						"node_modules/foo/index.js": "",
						"node_modules/foo/.dot.js": "",
						"node_modules/bar/index.js": "",
						"foo.js": "",
					},
				});

				beforeEach(prepare);
				afterEach(cleanup);

				it("'isPathIgnored()' should return 'false' for 'node_modules/foo/index.js'.", async () => {
					const engine = new ESLint({ flags, cwd: getPath() });

					assert.strictEqual(
						await engine.isPathIgnored("node_modules/foo/index.js"),
						false,
					);
				});

				it("'isPathIgnored()' should return 'false' for 'node_modules/foo/.dot.js'.", async () => {
					const engine = new ESLint({ flags, cwd: getPath() });

					assert.strictEqual(
						await engine.isPathIgnored("node_modules/foo/.dot.js"),
						false,
					);
				});

				it("'isPathIgnored()' should return 'true' for 'node_modules/bar/index.js'.", async () => {
					const engine = new ESLint({ flags, cwd: getPath() });

					assert.strictEqual(
						await engine.isPathIgnored("node_modules/bar/index.js"),
						true,
					);
				});

				it("'lintFiles()' should verify 'node_modules/foo/index.js'.", async () => {
					const engine = new ESLint({ flags, cwd: getPath() });
					const result = await engine.lintFiles("**/*.js");

					const filePaths = result.map(r => r.filePath).sort();

					assert.deepStrictEqual(filePaths, [
						path.join(getPath(), "eslint.config.js"),
						path.join(getPath(), "foo.js"),
						path.join(getPath(), "node_modules/foo/.dot.js"),
						path.join(getPath(), "node_modules/foo/index.js"),
					]);
				});
			});

			describe("ignore pattern can re-ignore files that are unignored by a previous pattern.", () => {
				const { prepare, cleanup, getPath } = createCustomTeardown({
					cwd: `${root}-reignore`,
					files: {
						"eslint.config.js": `module.exports = ${JSON.stringify({
							ignores: ["!.*", ".foo*"],
						})}`,
						".foo.js": "",
						".bar.js": "",
					},
				});

				beforeEach(prepare);
				afterEach(cleanup);

				it("'isPathIgnored()' should return 'true' for re-ignored '.foo.js'.", async () => {
					const engine = new ESLint({ flags, cwd: getPath() });

					assert.strictEqual(
						await engine.isPathIgnored(".foo.js"),
						true,
					);
				});

				it("'isPathIgnored()' should return 'false' for unignored '.bar.js'.", async () => {
					const engine = new ESLint({ flags, cwd: getPath() });

					assert.strictEqual(
						await engine.isPathIgnored(".bar.js"),
						false,
					);
				});

				it("'lintFiles()' should not lint re-ignored '.foo.js'.", async () => {
					const engine = new ESLint({ flags, cwd: getPath() });
					const filePaths = (await engine.lintFiles("**/*.js"))
						.map(r => r.filePath)
						.sort();

					assert.deepStrictEqual(filePaths, [
						path.join(getPath(), ".bar.js"),
						path.join(getPath(), "eslint.config.js"),
					]);
				});
			});

			describe("ignore pattern can unignore files that are ignored by a previous pattern.", () => {
				const { prepare, cleanup, getPath } = createCustomTeardown({
					cwd: `${root}-dignore`,
					files: {
						"eslint.config.js": `module.exports = ${JSON.stringify({
							ignores: ["**/*.js", "!foo.js"],
						})}`,
						"foo.js": "",
						"bar.js": "",
					},
				});

				beforeEach(prepare);
				afterEach(cleanup);

				it("'isPathIgnored()' should return 'false' for unignored 'foo.js'.", async () => {
					const engine = new ESLint({ flags, cwd: getPath() });

					assert.strictEqual(
						await engine.isPathIgnored("foo.js"),
						false,
					);
				});

				it("'isPathIgnored()' should return 'true' for ignored 'bar.js'.", async () => {
					const engine = new ESLint({ flags, cwd: getPath() });

					assert.strictEqual(
						await engine.isPathIgnored("bar.js"),
						true,
					);
				});

				it("'lintFiles()' should verify unignored 'foo.js'.", async () => {
					const engine = new ESLint({ flags, cwd: getPath() });
					const filePaths = (await engine.lintFiles("**/*.js"))
						.map(r => r.filePath)
						.sort();

					assert.deepStrictEqual(filePaths, [
						path.join(getPath(), "foo.js"),
					]);
				});
			});

			describe("ignores in a config file should not be used if ignore: false.", () => {
				const { prepare, cleanup, getPath } = createCustomTeardown({
					cwd: root,
					files: {
						"eslint.config.js": `module.exports = {
                            ignores: ["*.js"]
                        }`,
						"foo.js": "",
					},
				});

				beforeEach(prepare);
				afterEach(cleanup);

				it("'isPathIgnored()' should return 'false' for 'foo.js'.", async () => {
					const engine = new ESLint({
						flags,
						cwd: getPath(),
						ignore: false,
					});

					assert.strictEqual(
						await engine.isPathIgnored("foo.js"),
						false,
					);
				});

				it("'lintFiles()' should verify 'foo.js'.", async () => {
					const engine = new ESLint({
						flags,
						cwd: getPath(),
						ignore: false,
					});
					const filePaths = (await engine.lintFiles("**/*.js"))
						.map(r => r.filePath)
						.sort();

					assert.deepStrictEqual(filePaths, [
						path.join(root, "eslint.config.js"),
						path.join(root, "foo.js"),
					]);
				});
			});
		});

		describe("config.files adds lint targets", () => {
			const root = getFixturePath("cli-engine/additional-lint-targets");

			describe("if { files: 'foo/*.txt', ignores: '**/ignore.txt' } is present,", () => {
				const { prepare, cleanup, getPath } = createCustomTeardown({
					cwd: root + 1,
					files: {
						"eslint.config.js": `module.exports = [{
                            files: ["foo/*.txt"],
                            ignores: ["**/ignore.txt"]
                        }];`,
						"foo/nested/test.txt": "",
						"foo/test.js": "",
						"foo/test.txt": "",
						"foo/ignore.txt": "",
						"bar/test.js": "",
						"bar/test.txt": "",
						"bar/ignore.txt": "",
						"test.js": "",
						"test.txt": "",
						"ignore.txt": "",
					},
				});

				beforeEach(prepare);
				afterEach(cleanup);

				it("'lintFiles()' with a directory path should contain 'foo/test.txt'.", async () => {
					const engine = new ESLint({ flags, cwd: getPath() });
					const filePaths = (await engine.lintFiles("."))
						.map(r => r.filePath)
						.sort();

					assert.deepStrictEqual(filePaths, [
						path.join(getPath(), "bar/test.js"),
						path.join(getPath(), "eslint.config.js"),
						path.join(getPath(), "foo/test.js"),
						path.join(getPath(), "foo/test.txt"),
						path.join(getPath(), "test.js"),
					]);
				});

				it("'lintFiles()' with a glob pattern '*.js' should not contain 'foo/test.txt'.", async () => {
					const engine = new ESLint({ flags, cwd: getPath() });
					const filePaths = (await engine.lintFiles("**/*.js"))
						.map(r => r.filePath)
						.sort();

					assert.deepStrictEqual(filePaths, [
						path.join(getPath(), "bar/test.js"),
						path.join(getPath(), "eslint.config.js"),
						path.join(getPath(), "foo/test.js"),
						path.join(getPath(), "test.js"),
					]);
				});
			});

			describe("if { files: 'foo/*.txt', ignores: '**/ignore.txt' } is present and subdirectory is passed,", () => {
				const { prepare, cleanup, getPath } = createCustomTeardown({
					cwd: root + 2,
					files: {
						"eslint.config.js": `module.exports = [{
                            files: ["foo/*.txt"],
                            ignores: ["**/ignore.txt"]
                        }];`,
						"foo/nested/test.txt": "",
						"foo/test.js": "",
						"foo/test.txt": "",
						"foo/ignore.txt": "",
						"bar/test.js": "",
						"bar/test.txt": "",
						"bar/ignore.txt": "",
						"test.js": "",
						"test.txt": "",
						"ignore.txt": "",
					},
				});

				beforeEach(prepare);
				afterEach(cleanup);

				it("'lintFiles()' with a directory path should contain 'foo/test.txt'.", async () => {
					const engine = new ESLint({ flags, cwd: getPath() });
					const filePaths = (await engine.lintFiles("foo"))
						.map(r => r.filePath)
						.sort();

					assert.deepStrictEqual(filePaths, [
						path.join(getPath(), "foo/test.js"),
						path.join(getPath(), "foo/test.txt"),
					]);
				});

				it("'lintFiles()' with a glob pattern '*.js' should not contain 'foo/test.txt'.", async () => {
					const engine = new ESLint({ flags, cwd: getPath() });
					const filePaths = (await engine.lintFiles("foo/*.js"))
						.map(r => r.filePath)
						.sort();

					assert.deepStrictEqual(filePaths, [
						path.join(getPath(), "foo/test.js"),
					]);
				});
			});

			describe("if { files: 'foo/**/*.txt' } is present,", () => {
				const { prepare, cleanup, getPath } = createCustomTeardown({
					cwd: root + 3,
					files: {
						"eslint.config.js": `module.exports = [
                            {
                                files: ["foo/**/*.txt"]
                            }
                        ]`,
						"foo/nested/test.txt": "",
						"foo/test.js": "",
						"foo/test.txt": "",
						"bar/test.js": "",
						"bar/test.txt": "",
						"test.js": "",
						"test.txt": "",
					},
				});

				beforeEach(prepare);
				afterEach(cleanup);

				it("'lintFiles()' with a directory path should contain 'foo/test.txt' and 'foo/nested/test.txt'.", async () => {
					const engine = new ESLint({ flags, cwd: getPath() });
					const filePaths = (await engine.lintFiles("."))
						.map(r => r.filePath)
						.sort();

					assert.deepStrictEqual(filePaths, [
						path.join(getPath(), "bar/test.js"),
						path.join(getPath(), "eslint.config.js"),
						path.join(getPath(), "foo/nested/test.txt"),
						path.join(getPath(), "foo/test.js"),
						path.join(getPath(), "foo/test.txt"),
						path.join(getPath(), "test.js"),
					]);
				});
			});

			describe("if { files: 'foo/**/*' } is present,", () => {
				const { prepare, cleanup, getPath } = createCustomTeardown({
					cwd: root + 4,
					files: {
						"eslint.config.js": `module.exports = [
                            {
                                files: ["foo/**/*"]
                            }
                        ]`,
						"foo/nested/test.txt": "",
						"foo/test.js": "",
						"foo/test.txt": "",
						"bar/test.js": "",
						"bar/test.txt": "",
						"test.js": "",
						"test.txt": "",
					},
				});

				beforeEach(prepare);
				afterEach(cleanup);

				it("'lintFiles()' with a directory path should NOT contain 'foo/test.txt' and 'foo/nested/test.txt'.", async () => {
					const engine = new ESLint({ flags, cwd: getPath() });
					const filePaths = (await engine.lintFiles("."))
						.map(r => r.filePath)
						.sort();

					assert.deepStrictEqual(filePaths, [
						path.join(getPath(), "bar/test.js"),
						path.join(getPath(), "eslint.config.js"),
						path.join(getPath(), "foo/test.js"),
						path.join(getPath(), "test.js"),
					]);
				});
			});
		});

		describe("'ignores', 'files' of the configuration that the '--config' option provided should be resolved from CWD.", () => {
			const root = getFixturePath(
				"cli-engine/config-and-overrides-files",
			);

			describe("if { files: 'foo/*.txt', ... } is present by '--config node_modules/myconf/eslint.config.js',", () => {
				const { prepare, cleanup, getPath } = createCustomTeardown({
					cwd: `${root}a1`,
					files: {
						"node_modules/myconf/eslint.config.js": `module.exports = [
                            {
                                files: ["foo/*.js"],
                                rules: {
                                    eqeqeq: "error"
                                }
                            }
                        ];`,
						"node_modules/myconf/foo/test.js": "a == b",
						"foo/test.js": "a == b",
					},
				});

				beforeEach(prepare);
				afterEach(cleanup);

				it("'lintFiles()' with 'foo/test.js' should use the files entry.", async () => {
					const engine = new ESLint({
						flags,
						overrideConfigFile:
							"node_modules/myconf/eslint.config.js",
						cwd: getPath(),
						ignore: false,
					});
					const results = await engine.lintFiles("foo/test.js");

					// Expected to be an 'eqeqeq' error because the file matches to `$CWD/foo/*.js`.
					assert.deepStrictEqual(results, [
						{
							suppressedMessages: [],
							errorCount: 1,
							filePath: path.join(getPath(), "foo/test.js"),
							fixableErrorCount: 0,
							fixableWarningCount: 0,
							messages: [
								{
									column: 3,
									endColumn: 5,
									endLine: 1,
									line: 1,
									message:
										"Expected '===' and instead saw '=='.",
									messageId: "unexpected",
									nodeType: "BinaryExpression",
									ruleId: "eqeqeq",
									severity: 2,
									suggestions: [
										{
											data: {
												actualOperator: "==",
												expectedOperator: "===",
											},
											desc: "Use '===' instead of '=='.",
											fix: {
												range: [2, 4],
												text: "===",
											},
											messageId: "replaceOperator",
										},
									],
								},
							],
							source: "a == b",
							usedDeprecatedRules: [],
							warningCount: 0,
							fatalErrorCount: 0,
						},
					]);
				});

				it("'lintFiles()' with 'node_modules/myconf/foo/test.js' should NOT use the files entry.", async () => {
					const engine = new ESLint({
						flags,
						overrideConfigFile:
							"node_modules/myconf/eslint.config.js",
						cwd: getPath(),
						ignore: false,
					});
					const results = await engine.lintFiles(
						"node_modules/myconf/foo/test.js",
					);

					// Expected to be no errors because the file doesn't match to `$CWD/foo/*.js`.
					assert.deepStrictEqual(results, [
						{
							suppressedMessages: [],
							errorCount: 0,
							filePath: path.join(
								getPath(),
								"node_modules/myconf/foo/test.js",
							),
							fixableErrorCount: 0,
							fixableWarningCount: 0,
							messages: [
								{
									ruleId: null,
									fatal: false,
									message:
										'File ignored by default because it is located under the node_modules directory. Use ignore pattern "!**/node_modules/" to disable file ignore settings or use "--no-warn-ignored" to suppress this warning.',
									severity: 1,
									nodeType: null,
								},
							],
							usedDeprecatedRules: [],
							warningCount: 1,
							fatalErrorCount: 0,
						},
					]);
				});
			});

			describe("if { files: '*', ignores: 'foo/*.txt', ... } is present by '--config bar/myconf/eslint.config.js',", () => {
				const { prepare, cleanup, getPath } = createCustomTeardown({
					cwd: `${root}a2`,
					files: {
						"bar/myconf/eslint.config.js": `module.exports = [
                            {
                                files: ["**/*"],
                                ignores: ["foo/*.js"],
                                rules: {
                                    eqeqeq: "error"
                                }
                            }
                        ]`,
						"bar/myconf/foo/test.js": "a == b",
						"foo/test.js": "a == b",
					},
				});

				beforeEach(prepare);
				afterEach(cleanup);

				it("'lintFiles()' with 'foo/test.js' should have no errors because no rules are enabled.", async () => {
					const engine = new ESLint({
						flags,
						overrideConfigFile: "bar/myconf/eslint.config.js",
						cwd: getPath(),
						ignore: false,
					});
					const results = await engine.lintFiles("foo/test.js");

					// Expected to be no errors because the file matches to `$CWD/foo/*.js`.
					assert.deepStrictEqual(results, [
						{
							suppressedMessages: [],
							errorCount: 0,
							filePath: path.join(getPath(), "foo/test.js"),
							fixableErrorCount: 0,
							fixableWarningCount: 0,
							messages: [],
							usedDeprecatedRules: [],
							warningCount: 0,
							fatalErrorCount: 0,
						},
					]);
				});

				it("'lintFiles()' with 'bar/myconf/foo/test.js' should have an error because eqeqeq is enabled.", async () => {
					const engine = new ESLint({
						flags,
						overrideConfigFile: "bar/myconf/eslint.config.js",
						cwd: getPath(),
						ignore: false,
					});
					const results = await engine.lintFiles(
						"bar/myconf/foo/test.js",
					);

					// Expected to be an 'eqeqeq' error because the file doesn't match to `$CWD/foo/*.js`.
					assert.deepStrictEqual(results, [
						{
							suppressedMessages: [],
							errorCount: 1,
							filePath: path.join(
								getPath(),
								"bar/myconf/foo/test.js",
							),
							fixableErrorCount: 0,
							fixableWarningCount: 0,
							messages: [
								{
									column: 3,
									endColumn: 5,
									endLine: 1,
									line: 1,
									message:
										"Expected '===' and instead saw '=='.",
									messageId: "unexpected",
									nodeType: "BinaryExpression",
									ruleId: "eqeqeq",
									severity: 2,
									suggestions: [
										{
											data: {
												actualOperator: "==",
												expectedOperator: "===",
											},
											desc: "Use '===' instead of '=='.",
											fix: {
												range: [2, 4],
												text: "===",
											},
											messageId: "replaceOperator",
										},
									],
								},
							],
							source: "a == b",
							usedDeprecatedRules: [],
							warningCount: 0,
							fatalErrorCount: 0,
						},
					]);
				});
			});

			describe("if { ignores: 'foo/*.js', ... } is present by '--config node_modules/myconf/eslint.config.js',", () => {
				const { prepare, cleanup, getPath } = createCustomTeardown({
					cwd: `${root}a3`,
					files: {
						"node_modules/myconf/eslint.config.js": `module.exports = [{
                            ignores: ["!node_modules", "node_modules/*", "!node_modules/myconf", "foo/*.js"],
                        }, {
                            rules: {
                                eqeqeq: "error"
                            }
                        }]`,
						"node_modules/myconf/foo/test.js": "a == b",
						"foo/test.js": "a == b",
					},
				});

				beforeEach(prepare);
				afterEach(cleanup);

				it("'lintFiles()' with '**/*.js' should lint 'node_modules/myconf/foo/test.js' but not 'foo/test.js'.", async () => {
					const engine = new ESLint({
						flags,
						overrideConfigFile:
							"node_modules/myconf/eslint.config.js",
						cwd: getPath(),
					});
					const files = (await engine.lintFiles("**/*.js"))
						.map(r => r.filePath)
						.sort();

					assert.deepStrictEqual(files, [
						path.join(
							getPath(),
							"node_modules/myconf/eslint.config.js",
						),
						path.join(getPath(), "node_modules/myconf/foo/test.js"),
					]);
				});
			});
		});

		describe("baseConfig", () => {
			it("can be an object", async () => {
				const eslint = new ESLint({
					flags,
					overrideConfigFile: true,
					baseConfig: {
						rules: {
							semi: 2,
						},
					},
				});

				const [{ messages }] = await eslint.lintText("foo");

				assert.strictEqual(messages.length, 1);
				assert.strictEqual(messages[0].ruleId, "semi");
			});

			it("can be an array", async () => {
				const eslint = new ESLint({
					flags,
					overrideConfigFile: true,
					baseConfig: [
						{
							rules: {
								"no-var": 2,
							},
						},
						{
							rules: {
								semi: 2,
							},
						},
					],
				});

				const [{ messages }] = await eslint.lintText("var foo");

				assert.strictEqual(messages.length, 2);
				assert.strictEqual(messages[0].ruleId, "no-var");
				assert.strictEqual(messages[1].ruleId, "semi");
			});

			it("should be inserted after default configs", async () => {
				const eslint = new ESLint({
					flags,
					overrideConfigFile: true,
					baseConfig: {
						languageOptions: {
							ecmaVersion: 5,
							sourceType: "script",
						},
					},
				});

				const [{ messages }] = await eslint.lintText("let x");

				/*
				 * if baseConfig was inserted before default configs,
				 * `ecmaVersion: "latest"` from default configs would overwrite
				 * `ecmaVersion: 5` from baseConfig, so this wouldn't be a parsing error.
				 */

				assert.strictEqual(messages.length, 1);
				assert(messages[0].fatal, "Fatal error expected.");
			});

			it("should be inserted before configs from the config file", async () => {
				const eslint = new ESLint({
					flags,
					cwd: getFixturePath(),
					baseConfig: {
						rules: {
							strict: ["error", "global"],
						},
						languageOptions: {
							sourceType: "script",
						},
					},
				});

				const [{ messages }] = await eslint.lintText("foo");

				/*
				 * if baseConfig was inserted after configs from the config file,
				 * `strict: 0` from eslint.config.js wouldn't overwrite `strict: ["error", "global"]`
				 * from baseConfig, so there would be an error message from the `strict` rule.
				 */

				assert.strictEqual(messages.length, 0);
			});

			it("should be inserted before overrideConfig", async () => {
				const eslint = new ESLint({
					flags,
					overrideConfigFile: true,
					baseConfig: {
						rules: {
							semi: 2,
						},
					},
					overrideConfig: {
						rules: {
							semi: 1,
						},
					},
				});

				const [{ messages }] = await eslint.lintText("foo");

				assert.strictEqual(messages.length, 1);
				assert.strictEqual(messages[0].ruleId, "semi");
				assert.strictEqual(messages[0].severity, 1);
			});

			it("should be inserted before configs from the config file and overrideConfig", async () => {
				const eslint = new ESLint({
					flags,
					overrideConfigFile: getFixturePath(
						"eslint.config-with-rules.js",
					),
					baseConfig: {
						rules: {
							quotes: ["error", "double"],
							semi: "error",
						},
					},
					overrideConfig: {
						rules: {
							quotes: "warn",
						},
					},
				});

				const [{ messages }] =
					await eslint.lintText('const foo = "bar"');

				/*
				 * baseConfig: { quotes: ["error", "double"], semi: "error" }
				 * eslint.config-with-rules.js: { quotes: ["error", "single"] }
				 * overrideConfig: { quotes: "warn" }
				 *
				 * Merged config: { quotes: ["warn", "single"], semi: "error" }
				 */

				assert.strictEqual(messages.length, 2);
				assert.strictEqual(messages[0].ruleId, "quotes");
				assert.strictEqual(messages[0].severity, 1);
				assert.strictEqual(messages[1].ruleId, "semi");
				assert.strictEqual(messages[1].severity, 2);
			});

			it("when it has 'files' they should be interpreted as relative to the config file", async () => {
				/*
				 * `fixtures/plugins` directory does not have a config file.
				 * It's parent directory `fixtures` does have a config file, so
				 * the base path will be `fixtures`, cwd will be `fixtures/plugins`
				 */
				const eslint = new ESLint({
					flags,
					cwd: getFixturePath("plugins"),
					baseConfig: {
						files: ["plugins/a.js"],
						rules: {
							semi: 2,
						},
					},
				});

				const [{ messages }] = await eslint.lintText("foo", {
					filePath: getFixturePath("plugins/a.js"),
				});

				assert.strictEqual(messages.length, 1);
				assert.strictEqual(messages[0].ruleId, "semi");
			});

			it("when it has 'ignores' they should be interpreted as relative to the config file", async () => {
				/*
				 * `fixtures/plugins` directory does not have a config file.
				 * It's parent directory `fixtures` does have a config file, so
				 * the base path will be `fixtures`, cwd will be `fixtures/plugins`
				 */
				const eslint = new ESLint({
					flags,
					cwd: getFixturePath("plugins"),
					baseConfig: {
						ignores: ["plugins/a.js"],
					},
				});

				const [{ messages }] = await eslint.lintText("foo", {
					filePath: getFixturePath("plugins/a.js"),
					warnIgnored: true,
				});

				assert.strictEqual(messages.length, 1);
				assert.strictEqual(messages[0].severity, 1);
				assert.match(messages[0].message, /ignored/u);
			});
		});

		describe("config file", () => {
			it("new instance of ESLint should use the latest version of the config file (ESM)", async () => {
				const cwd = path.join(
					getFixturePath(),
					`config_file_${Date.now()}`,
				);
				const configFileContent =
					"export default [{ rules: { semi: ['error', 'always'] } }];";
				const teardown = createCustomTeardown({
					cwd,
					files: {
						"package.json": '{ "type": "module" }',
						"eslint.config.js": configFileContent,
						"a.js": "foo\nbar;",
					},
				});

				await teardown.prepare();

				let eslint = new ESLint({ flags, cwd });
				let [{ messages }] = await eslint.lintFiles(["a.js"]);

				assert.strictEqual(messages.length, 1);
				assert.strictEqual(messages[0].ruleId, "semi");
				assert.strictEqual(messages[0].messageId, "missingSemi");
				assert.strictEqual(messages[0].line, 1);

				await sleep(100);
				await fsp.writeFile(
					path.join(cwd, "eslint.config.js"),
					configFileContent.replace("always", "never"),
				);

				eslint = new ESLint({ flags, cwd });
				[{ messages }] = await eslint.lintFiles(["a.js"]);

				assert.strictEqual(messages.length, 1);
				assert.strictEqual(messages[0].ruleId, "semi");
				assert.strictEqual(messages[0].messageId, "extraSemi");
				assert.strictEqual(messages[0].line, 2);
			});

			it("new instance of ESLint should use the latest version of the config file (CJS)", async () => {
				const cwd = path.join(
					getFixturePath(),
					`config_file_${Date.now()}`,
				);
				const configFileContent =
					"module.exports = [{ rules: { semi: ['error', 'always'] } }];";
				const teardown = createCustomTeardown({
					cwd,
					files: {
						"eslint.config.js": configFileContent,
						"a.js": "foo\nbar;",
					},
				});

				await teardown.prepare();

				let eslint = new ESLint({ flags, cwd });
				let [{ messages }] = await eslint.lintFiles(["a.js"]);

				assert.strictEqual(messages.length, 1);
				assert.strictEqual(messages[0].ruleId, "semi");
				assert.strictEqual(messages[0].messageId, "missingSemi");
				assert.strictEqual(messages[0].line, 1);

				await sleep(100);
				await fsp.writeFile(
					path.join(cwd, "eslint.config.js"),
					configFileContent.replace("always", "never"),
				);

				eslint = new ESLint({ flags, cwd });
				[{ messages }] = await eslint.lintFiles(["a.js"]);

				assert.strictEqual(messages.length, 1);
				assert.strictEqual(messages[0].ruleId, "semi");
				assert.strictEqual(messages[0].messageId, "extraSemi");
				assert.strictEqual(messages[0].line, 2);
			});

			it("new instance of ESLint should use the latest version of the config file (TypeScript)", async () => {
				const cwd = getFixturePath(`config_file_${Date.now()}`);
				const configFileContent =
					"export default [{ rules: { semi: ['error', 'always'] } }];";
				const teardown = createCustomTeardown({
					cwd,
					files: {
						"eslint.config.ts": configFileContent,
						"a.js": "foo\nbar;",
					},
				});

				await teardown.prepare();

				let eslint = new ESLint({ flags, cwd });
				let [{ messages }] = await eslint.lintFiles(["a.js"]);

				assert.strictEqual(messages.length, 1);
				assert.strictEqual(messages[0].ruleId, "semi");
				assert.strictEqual(messages[0].messageId, "missingSemi");
				assert.strictEqual(messages[0].line, 1);

				await sleep(100);
				await fsp.writeFile(
					path.join(cwd, "eslint.config.ts"),
					configFileContent.replace("always", "never"),
				);

				eslint = new ESLint({ flags, cwd });
				[{ messages }] = await eslint.lintFiles(["a.js"]);

				assert.strictEqual(messages.length, 1);
				assert.strictEqual(messages[0].ruleId, "semi");
				assert.strictEqual(messages[0].messageId, "extraSemi");
				assert.strictEqual(messages[0].line, 2);
			});
		});

		// only works on a Windows machine
		if (os.platform() === "win32") {
			// https://github.com/eslint/eslint/issues/17042
			describe("with cwd that is using forward slash on Windows", () => {
				const cwd = getFixturePath("example-app3");
				const cwdForwardSlash = cwd.replace(/\\/gu, "/");

				it("should correctly handle ignore patterns", async () => {
					const engine = new ESLint({ flags, cwd: cwdForwardSlash });
					const results = await engine.lintFiles(["./src"]);

					// src/dist/2.js should be ignored
					assert.strictEqual(results.length, 1);
					assert.strictEqual(
						results[0].filePath,
						path.join(cwd, "src\\1.js"),
					);
				});

				it("should pass cwd with backslashes to rules", async () => {
					const engine = new ESLint({
						flags,
						cwd: cwdForwardSlash,
						overrideConfigFile: true,
						overrideConfig: {
							plugins: {
								test: require(
									path.join(
										cwd,
										"node_modules",
										"eslint-plugin-test",
									),
								),
							},
							rules: {
								"test/report-cwd": "error",
							},
						},
					});
					const results = await engine.lintText("");

					assert.strictEqual(
						results[0].messages[0].ruleId,
						"test/report-cwd",
					);
					assert.strictEqual(results[0].messages[0].message, cwd);
				});

				it("should pass cwd with backslashes to formatters", async () => {
					const engine = new ESLint({
						flags,
						cwd: cwdForwardSlash,
					});
					const results = await engine.lintText("");
					const formatter = await engine.loadFormatter("cwd");

					assert.strictEqual(formatter.format(results), cwd);
				});
			});
		}

		describe("config with circular references", () => {
			it("in 'settings'", async () => {
				let resolvedSettings = null;

				const circular = {};

				circular.self = circular;

				const eslint = new ESLint({
					flags,
					overrideConfigFile: true,
					baseConfig: {
						settings: {
							sharedData: circular,
						},
						rules: {
							"test-plugin/test-rule": 1,
						},
					},
					plugins: {
						"test-plugin": {
							rules: {
								"test-rule": {
									create(context) {
										resolvedSettings = context.settings;
										return {};
									},
								},
							},
						},
					},
				});

				await eslint.lintText("debugger;");

				assert.deepStrictEqual(resolvedSettings.sharedData, circular);
			});

			it("in 'parserOptions'", async () => {
				let resolvedParserOptions = null;

				const circular = {};

				circular.self = circular;

				const eslint = new ESLint({
					flags,
					overrideConfigFile: true,
					baseConfig: {
						languageOptions: {
							parser: {
								parse(text, parserOptions) {
									resolvedParserOptions = parserOptions;
									return espree.parse(text, parserOptions);
								},
							},
							parserOptions: {
								testOption: circular,
							},
						},
					},
				});

				await eslint.lintText("debugger;");

				assert.deepStrictEqual(
					resolvedParserOptions.testOption,
					circular,
				);
			});
		});
	});

	describe("shouldUseFlatConfig", () => {
		/**
		 * Check that `shouldUseFlatConfig` returns the expected value from a CWD
		 * with a flat config and one without a flat config.
		 * @param {boolean} expectedValueWithConfig the expected return value of
		 * `shouldUseFlatConfig` when in a directory with a flat config present
		 * @param {boolean} expectedValueWithoutConfig the expected return value of
		 * `shouldUseFlatConfig` when in a directory without any flat config present
		 * @returns {void}
		 */
		function testShouldUseFlatConfig(
			expectedValueWithConfig,
			expectedValueWithoutConfig,
		) {
			describe("when there is a flat config file present", () => {
				const originalCwd = process.cwd();

				beforeEach(() => {
					process.chdir(__dirname);
				});

				afterEach(() => {
					process.chdir(originalCwd);
				});

				it(`is \`${expectedValueWithConfig}\``, async () => {
					assert.strictEqual(
						await shouldUseFlatConfig(),
						expectedValueWithConfig,
					);
				});
			});

			describe("when there is no flat config file present", () => {
				const originalCwd = process.cwd();

				beforeEach(() => {
					process.chdir(os.tmpdir());
				});

				afterEach(() => {
					process.chdir(originalCwd);
				});

				it(`is \`${expectedValueWithoutConfig}\``, async () => {
					assert.strictEqual(
						await shouldUseFlatConfig(),
						expectedValueWithoutConfig,
					);
				});
			});
		}

		describe("when the env variable `ESLINT_USE_FLAT_CONFIG` is `'true'`", () => {
			beforeEach(() => {
				process.env.ESLINT_USE_FLAT_CONFIG = true;
			});

			afterEach(() => {
				delete process.env.ESLINT_USE_FLAT_CONFIG;
			});

			testShouldUseFlatConfig(true, true);
		});

		describe("when the env variable `ESLINT_USE_FLAT_CONFIG` is `'false'`", () => {
			beforeEach(() => {
				process.env.ESLINT_USE_FLAT_CONFIG = false;
			});

			afterEach(() => {
				delete process.env.ESLINT_USE_FLAT_CONFIG;
			});

			testShouldUseFlatConfig(false, false);
		});

		describe("when the env variable `ESLINT_USE_FLAT_CONFIG` is unset", () => {
			testShouldUseFlatConfig(true, true);
		});
	});

	describe("cache", () => {
		let eslint;

		/**
		 * helper method to delete a file without caring about exceptions
		 * @param {string} filePath The file path
		 * @returns {void}
		 */
		function doDelete(filePath) {
			try {
				fs.unlinkSync(filePath);
			} catch {
				/*
				 * we don't care if the file didn't exist, since our
				 * intention was to remove the file
				 */
			}
		}

		let cacheFilePath;

		beforeEach(() => {
			cacheFilePath = null;
		});

		afterEach(() => {
			sinon.restore();
			if (cacheFilePath) {
				doDelete(cacheFilePath);
			}
		});

		describe("when cacheLocation is a directory or looks like a directory", () => {
			const cwd = getFixturePath();

			/**
			 * helper method to delete the directory used in testing
			 * @returns {void}
			 */
			function deleteCacheDir() {
				try {
					fs.rmSync(path.resolve(cwd, "tmp/.cacheFileDir/"), {
						recursive: true,
						force: true,
					});
				} catch {
					/*
					 * we don't care if the file didn't exist, since our
					 * intention was to remove the file
					 */
				}
			}
			beforeEach(() => {
				deleteCacheDir();
			});

			afterEach(() => {
				deleteCacheDir();
			});

			it("should create the directory and the cache file inside it when cacheLocation ends with a slash", async () => {
				assert(
					!shell.test(
						"-d",
						path.resolve(cwd, "./tmp/.cacheFileDir/"),
					),
					"the cache directory already exists and wasn't successfully deleted",
				);

				eslint = new ESLint({
					overrideConfigFile: true,
					cwd,

					// specifying cache true the cache will be created
					cache: true,
					cacheLocation: "./tmp/.cacheFileDir/",
					overrideConfig: {
						rules: {
							"no-console": 0,
							"no-unused-vars": 2,
						},
					},
					ignore: false,
				});
				const file = getFixturePath("cache/src", "test-file.js");

				await eslint.lintFiles([file]);

				assert(
					shell.test(
						"-f",
						path.resolve(
							cwd,
							`./tmp/.cacheFileDir/.cache_${hash(cwd)}`,
						),
					),
					"the cache for eslint should have been created",
				);
			});

			it("should create the cache file inside existing cacheLocation directory when cacheLocation ends with a slash", async () => {
				assert(
					!shell.test(
						"-d",
						path.resolve(cwd, "./tmp/.cacheFileDir/"),
					),
					"the cache directory already exists and wasn't successfully deleted",
				);

				fs.mkdirSync(path.resolve(cwd, "./tmp/.cacheFileDir/"), {
					recursive: true,
				});

				eslint = new ESLint({
					overrideConfigFile: true,
					cwd,

					// specifying cache true the cache will be created
					cache: true,
					cacheLocation: "./tmp/.cacheFileDir/",
					overrideConfig: {
						rules: {
							"no-console": 0,
							"no-unused-vars": 2,
						},
					},
					ignore: false,
				});
				const file = getFixturePath("cache/src", "test-file.js");

				await eslint.lintFiles([file]);

				assert(
					shell.test(
						"-f",
						path.resolve(
							cwd,
							`./tmp/.cacheFileDir/.cache_${hash(cwd)}`,
						),
					),
					"the cache for eslint should have been created",
				);
			});

			it("should create the cache file inside existing cacheLocation directory when cacheLocation doesn't end with a path separator", async () => {
				assert(
					!shell.test(
						"-d",
						path.resolve(cwd, "./tmp/.cacheFileDir/"),
					),
					"the cache directory already exists and wasn't successfully deleted",
				);

				fs.mkdirSync(path.resolve(cwd, "./tmp/.cacheFileDir/"), {
					recursive: true,
				});

				eslint = new ESLint({
					overrideConfigFile: true,
					cwd,

					// specifying cache true the cache will be created
					cache: true,
					cacheLocation: "./tmp/.cacheFileDir",
					overrideConfig: {
						rules: {
							"no-console": 0,
							"no-unused-vars": 2,
						},
					},
					ignore: false,
				});
				const file = getFixturePath("cache/src", "test-file.js");

				await eslint.lintFiles([file]);

				assert(
					shell.test(
						"-f",
						path.resolve(
							cwd,
							`./tmp/.cacheFileDir/.cache_${hash(cwd)}`,
						),
					),
					"the cache for eslint should have been created",
				);
			});
		});

		it("should create the cache file inside cwd when no cacheLocation provided", async () => {
			const cwd = path.resolve(getFixturePath("cli-engine"));

			cacheFilePath = path.resolve(cwd, ".eslintcache");
			doDelete(cacheFilePath);
			assert(
				!shell.test("-f", cacheFilePath),
				"the cache file already exists and wasn't successfully deleted",
			);

			eslint = new ESLint({
				overrideConfigFile: true,
				cache: true,
				cwd,
				overrideConfig: {
					rules: {
						"no-console": 0,
					},
				},
				ignore: false,
			});
			const file = getFixturePath("cli-engine", "console.js");

			await eslint.lintFiles([file]);

			assert(
				shell.test("-f", cacheFilePath),
				"the cache for eslint should have been created at provided cwd",
			);
		});

		it("should invalidate the cache if the overrideConfig changed between executions", async () => {
			const cwd = getFixturePath("cache/src");

			cacheFilePath = path.resolve(cwd, ".eslintcache");
			doDelete(cacheFilePath);
			assert(
				!shell.test("-f", cacheFilePath),
				"the cache file already exists and wasn't successfully deleted",
			);

			eslint = new ESLint({
				overrideConfigFile: true,
				cwd,

				// specifying cache true the cache will be created
				cache: true,
				overrideConfig: {
					rules: {
						"no-console": 0,
						"no-unused-vars": 2,
					},
				},
				ignore: false,
			});

			let spy = sinon.spy(fs.promises, "readFile");

			let file = path.join(cwd, "test-file.js");

			file = fs.realpathSync(file);
			const results = await eslint.lintFiles([file]);

			for (const { errorCount, warningCount } of results) {
				assert.strictEqual(
					errorCount + warningCount,
					0,
					"the file should have passed linting without errors or warnings",
				);
			}

			assert(
				spy.calledWith(file),
				"ESLint should have read the file because there was no cache file",
			);
			assert(
				shell.test("-f", cacheFilePath),
				"the cache for eslint should have been created",
			);

			// destroy the spy
			sinon.restore();

			eslint = new ESLint({
				overrideConfigFile: true,
				cwd,

				// specifying cache true the cache will be created
				cache: true,
				overrideConfig: {
					rules: {
						"no-console": 2,
						"no-unused-vars": 2,
					},
				},
				ignore: false,
			});

			// create a new spy
			spy = sinon.spy(fs.promises, "readFile");

			const [newResult] = await eslint.lintFiles([file]);

			assert(
				spy.calledWith(file),
				"ESLint should have read the file again because it's considered changed because the config changed",
			);
			assert.strictEqual(
				newResult.errorCount,
				1,
				"since configuration changed the cache should have not been used and one error should have been reported",
			);
			assert.strictEqual(newResult.messages[0].ruleId, "no-console");
			assert(
				shell.test("-f", cacheFilePath),
				"The cache for ESLint should still exist",
			);
		});

		it("should remember the files from a previous run and do not operate on them if not changed", async () => {
			const cwd = getFixturePath("cache/src");

			cacheFilePath = path.resolve(cwd, ".eslintcache");
			doDelete(cacheFilePath);
			assert(
				!shell.test("-f", cacheFilePath),
				"the cache file already exists and wasn't successfully deleted",
			);

			eslint = new ESLint({
				overrideConfigFile: true,
				cwd,

				// specifying cache true the cache will be created
				cache: true,
				overrideConfig: {
					rules: {
						"no-console": 0,
						"no-unused-vars": 2,
					},
				},
				ignore: false,
			});

			let spy = sinon.spy(fs.promises, "readFile");

			let file = getFixturePath("cache/src", "test-file.js");

			file = fs.realpathSync(file);

			const result = await eslint.lintFiles([file]);

			assert(
				spy.calledWith(file),
				"ESLint should have read the file because there was no cache file",
			);
			assert(
				shell.test("-f", cacheFilePath),
				"the cache for eslint should have been created",
			);

			// destroy the spy
			sinon.restore();

			eslint = new ESLint({
				overrideConfigFile: true,
				cwd,

				// specifying cache true the cache will be created
				cache: true,
				overrideConfig: {
					rules: {
						"no-console": 0,
						"no-unused-vars": 2,
					},
				},
				ignore: false,
			});

			// create a new spy
			spy = sinon.spy(fs.promises, "readFile");

			const cachedResult = await eslint.lintFiles([file]);

			assert.deepStrictEqual(
				result,
				cachedResult,
				"the result should have been the same",
			);

			// assert the file was not processed because the cache was used
			assert(
				!spy.calledWith(file),
				"the file should not have been reloaded",
			);
		});

		it("when `cacheLocation` is specified, should create the cache file with `cache:true` and then delete it with `cache:false`", async () => {
			cacheFilePath = getFixturePath(".eslintcache");
			doDelete(cacheFilePath);
			assert(
				!shell.test("-f", cacheFilePath),
				"the cache file already exists and wasn't successfully deleted",
			);

			const eslintOptions = {
				overrideConfigFile: true,

				// specifying cache true the cache will be created
				cache: true,
				cacheLocation: cacheFilePath,
				overrideConfig: {
					rules: {
						"no-console": 0,
						"no-unused-vars": 2,
					},
				},
				cwd: path.join(fixtureDir, ".."),
			};

			eslint = new ESLint(eslintOptions);

			let file = getFixturePath("cache/src", "test-file.js");

			file = fs.realpathSync(file);

			await eslint.lintFiles([file]);

			assert(
				shell.test("-f", cacheFilePath),
				"the cache for eslint should have been created",
			);

			eslintOptions.cache = false;
			eslint = new ESLint(eslintOptions);

			await eslint.lintFiles([file]);

			assert(
				!shell.test("-f", cacheFilePath),
				"the cache for eslint should have been deleted since last run did not use the cache",
			);
		});

		it("should not attempt to delete the cache file if it does not exist", async () => {
			cacheFilePath = getFixturePath(".eslintcache");
			doDelete(cacheFilePath);
			assert(
				!shell.test("-f", cacheFilePath),
				"the cache file already exists and wasn't successfully deleted",
			);

			const spy = sinon.spy(fsp, "unlink");

			const eslintOptions = {
				overrideConfigFile: true,
				cache: false,
				cacheLocation: cacheFilePath,
				overrideConfig: {
					rules: {
						"no-console": 0,
						"no-unused-vars": 2,
					},
				},
				cwd: path.join(fixtureDir, ".."),
			};

			eslint = new ESLint(eslintOptions);

			const file = getFixturePath("cache/src", "test-file.js");

			await eslint.lintFiles([file]);

			assert(
				spy.notCalled,
				"Expected attempt to delete the cache was not made.",
			);

			spy.restore();
		});

		it("should throw an error if the cache file to be deleted exist on a read-only file system", async () => {
			cacheFilePath = getFixturePath(".eslintcache");
			fs.writeFileSync(cacheFilePath, "");

			// Simulate a read-only file system.
			const unlinkStub = sinon.stub(fsp, "unlink").rejects(
				Object.assign(new Error("read-only file system"), {
					code: "EROFS",
				}),
			);

			const eslintOptions = {
				overrideConfigFile: true,
				cache: false,
				cacheLocation: cacheFilePath,
				overrideConfig: {
					rules: {
						"no-console": 0,
						"no-unused-vars": 2,
					},
				},
				cwd: path.join(fixtureDir, ".."),
			};

			eslint = new ESLint(eslintOptions);

			const file = getFixturePath("cache/src", "test-file.js");

			await assert.rejects(
				async () => await eslint.lintFiles([file]),
				/read-only file system/u,
			);

			unlinkStub.restore();
		});

		it("should not throw an error if deleting fails but cache file no longer exists", async () => {
			cacheFilePath = getFixturePath(".eslintcache");
			fs.writeFileSync(cacheFilePath, "");

			const unlinkStub = sinon.stub(fsp, "unlink").callsFake(() => {
				doDelete(cacheFilePath);
				throw new Error("Failed to delete cache file");
			});

			const eslintOptions = {
				overrideConfigFile: true,
				cache: false,
				cacheLocation: cacheFilePath,
				overrideConfig: {
					rules: {
						"no-console": 0,
						"no-unused-vars": 2,
					},
				},
				cwd: path.join(fixtureDir, ".."),
			};

			eslint = new ESLint(eslintOptions);

			const file = getFixturePath("cache/src", "test-file.js");

			await eslint.lintFiles([file]);

			assert(unlinkStub.calledWithExactly(cacheFilePath));

			unlinkStub.restore();
		});

		it("should store in the cache a file that has lint messages and a file that doesn't have lint messages", async () => {
			cacheFilePath = getFixturePath(".eslintcache");
			doDelete(cacheFilePath);
			assert(
				!shell.test("-f", cacheFilePath),
				"the cache file already exists and wasn't successfully deleted",
			);

			eslint = new ESLint({
				cwd: path.join(fixtureDir, ".."),
				overrideConfigFile: true,

				// specifying cache true the cache will be created
				cache: true,
				cacheLocation: cacheFilePath,
				overrideConfig: {
					rules: {
						"no-console": 0,
						"no-unused-vars": 2,
					},
				},
			});
			const badFile = fs.realpathSync(
				getFixturePath("cache/src", "fail-file.js"),
			);
			const goodFile = fs.realpathSync(
				getFixturePath("cache/src", "test-file.js"),
			);
			const result = await eslint.lintFiles([badFile, goodFile]);
			const [badFileResult, goodFileResult] = result;

			assert.notStrictEqual(
				badFileResult.errorCount + badFileResult.warningCount,
				0,
				"the bad file should have some lint errors or warnings",
			);
			assert.strictEqual(
				goodFileResult.errorCount + badFileResult.warningCount,
				0,
				"the good file should have passed linting without errors or warnings",
			);

			assert(
				shell.test("-f", cacheFilePath),
				"the cache for eslint should have been created",
			);

			const fileCache = fCache.createFromFile(cacheFilePath);
			const { cache } = fileCache;

			assert.strictEqual(
				typeof cache.getKey(goodFile),
				"object",
				"the entry for the good file should have been in the cache",
			);
			assert.strictEqual(
				typeof cache.getKey(badFile),
				"object",
				"the entry for the bad file should have been in the cache",
			);
			const cachedResult = await eslint.lintFiles([badFile, goodFile]);

			assert.deepStrictEqual(
				result,
				cachedResult,
				"result should be the same with or without cache",
			);
		});

		it("should not contain in the cache a file that was deleted", async () => {
			cacheFilePath = getFixturePath(".eslintcache");
			doDelete(cacheFilePath);
			assert(
				!shell.test("-f", cacheFilePath),
				"the cache file already exists and wasn't successfully deleted",
			);
			eslint = new ESLint({
				cwd: path.join(fixtureDir, ".."),
				overrideConfigFile: true,

				// specifying cache true the cache will be created
				cache: true,
				cacheLocation: cacheFilePath,
				overrideConfig: {
					rules: {
						"no-console": 0,
						"no-unused-vars": 2,
					},
				},
			});
			const badFile = fs.realpathSync(
				getFixturePath("cache/src", "fail-file.js"),
			);
			const goodFile = fs.realpathSync(
				getFixturePath("cache/src", "test-file.js"),
			);
			const toBeDeletedFile = fs.realpathSync(
				getFixturePath("cache/src", "file-to-delete.js"),
			);

			await eslint.lintFiles([badFile, goodFile, toBeDeletedFile]);
			const fileCache = fCache.createFromFile(cacheFilePath);
			let { cache } = fileCache;

			assert.strictEqual(
				typeof cache.getKey(toBeDeletedFile),
				"object",
				"the entry for the file to be deleted should have been in the cache",
			);

			// delete the file from the file system
			fs.unlinkSync(toBeDeletedFile);

			/*
			 * file-entry-cache@2.0.0 will remove from the cache deleted files
			 * even when they were not part of the array of files to be analyzed
			 */
			await eslint.lintFiles([badFile, goodFile]);

			cache = JSON.parse(fs.readFileSync(cacheFilePath));

			assert.strictEqual(
				typeof cache[0][toBeDeletedFile],
				"undefined",
				"the entry for the file to be deleted should not have been in the cache",
			);

			// make sure that the previos assertion checks the right place
			assert.notStrictEqual(
				typeof cache[0][badFile],
				"undefined",
				"the entry for the bad file should have been in the cache",
			);
			assert.notStrictEqual(
				typeof cache[0][goodFile],
				"undefined",
				"the entry for the good file should have been in the cache",
			);
		});

		it("should contain files that were not visited in the cache provided they still exist", async () => {
			cacheFilePath = getFixturePath(".eslintcache");
			doDelete(cacheFilePath);
			assert(
				!shell.test("-f", cacheFilePath),
				"the cache file already exists and wasn't successfully deleted",
			);

			eslint = new ESLint({
				cwd: path.join(fixtureDir, ".."),
				overrideConfigFile: true,

				// specifying cache true the cache will be created
				cache: true,
				cacheLocation: cacheFilePath,
				overrideConfig: {
					rules: {
						"no-console": 0,
						"no-unused-vars": 2,
					},
				},
			});
			const badFile = fs.realpathSync(
				getFixturePath("cache/src", "fail-file.js"),
			);
			const goodFile = fs.realpathSync(
				getFixturePath("cache/src", "test-file.js"),
			);
			const testFile2 = fs.realpathSync(
				getFixturePath("cache/src", "test-file2.js"),
			);

			await eslint.lintFiles([badFile, goodFile, testFile2]);

			let fileCache = fCache.createFromFile(cacheFilePath);
			let { cache } = fileCache;

			assert.strictEqual(
				typeof cache.getKey(testFile2),
				"object",
				"the entry for the test-file2 should have been in the cache",
			);

			/*
			 * we pass a different set of files (minus test-file2)
			 * previous version of file-entry-cache would remove the non visited
			 * entries. 2.0.0 version will keep them unless they don't exist
			 */
			await eslint.lintFiles([badFile, goodFile]);

			fileCache = fCache.createFromFile(cacheFilePath);
			cache = fileCache.cache;

			assert.strictEqual(
				typeof cache.getKey(testFile2),
				"object",
				"the entry for the test-file2 should have been in the cache",
			);
		});

		it("should not delete cache when executing on text", async () => {
			cacheFilePath = getFixturePath(".eslintcache");
			doDelete(cacheFilePath);
			assert(
				!shell.test("-f", cacheFilePath),
				"the cache file already exists and wasn't successfully deleted",
			);

			fs.writeFileSync(cacheFilePath, "[]"); // intenationally invalid to additionally make sure it isn't used

			eslint = new ESLint({
				cwd: path.join(fixtureDir, ".."),
				overrideConfigFile: true,
				cacheLocation: cacheFilePath,
				overrideConfig: {
					rules: {
						"no-console": 0,
						"no-unused-vars": 2,
					},
				},
			});

			assert(
				shell.test("-f", cacheFilePath),
				"the cache for eslint should exist",
			);

			await eslint.lintText("var foo = 'bar';");

			assert(
				shell.test("-f", cacheFilePath),
				"the cache for eslint should still exist",
			);
		});

		it("should not delete cache when executing on text with a provided filename", async () => {
			cacheFilePath = getFixturePath(".eslintcache");
			doDelete(cacheFilePath);
			assert(
				!shell.test("-f", cacheFilePath),
				"the cache file already exists and wasn't successfully deleted",
			);

			fs.writeFileSync(cacheFilePath, "[]"); // intenationally invalid to additionally make sure it isn't used

			eslint = new ESLint({
				cwd: path.join(fixtureDir, ".."),
				overrideConfigFile: true,
				cacheLocation: cacheFilePath,
				overrideConfig: {
					rules: {
						"no-console": 0,
						"no-unused-vars": 2,
					},
				},
			});

			assert(
				shell.test("-f", cacheFilePath),
				"the cache for eslint should exist",
			);

			await eslint.lintText("var bar = foo;", {
				filePath: "fixtures/passing.js",
			});

			assert(
				shell.test("-f", cacheFilePath),
				"the cache for eslint should still exist",
			);
		});

		it("should not delete cache when executing on files with --cache flag", async () => {
			cacheFilePath = getFixturePath(".eslintcache");
			doDelete(cacheFilePath);
			assert(
				!shell.test("-f", cacheFilePath),
				"the cache file already exists and wasn't successfully deleted",
			);

			fs.writeFileSync(cacheFilePath, "");

			eslint = new ESLint({
				cwd: path.join(fixtureDir, ".."),
				overrideConfigFile: true,
				cache: true,
				cacheLocation: cacheFilePath,
				overrideConfig: {
					rules: {
						"no-console": 0,
						"no-unused-vars": 2,
					},
				},
			});
			const file = getFixturePath("cli-engine", "console.js");

			assert(
				shell.test("-f", cacheFilePath),
				"the cache for eslint should exist",
			);

			await eslint.lintFiles([file]);

			assert(
				shell.test("-f", cacheFilePath),
				"the cache for eslint should still exist",
			);
		});

		it("should delete cache when executing on files without --cache flag", async () => {
			cacheFilePath = getFixturePath(".eslintcache");
			doDelete(cacheFilePath);
			assert(
				!shell.test("-f", cacheFilePath),
				"the cache file already exists and wasn't successfully deleted",
			);

			fs.writeFileSync(cacheFilePath, "[]"); // intenationally invalid to additionally make sure it isn't used

			eslint = new ESLint({
				cwd: path.join(fixtureDir, ".."),
				overrideConfigFile: true,
				cacheLocation: cacheFilePath,
				overrideConfig: {
					rules: {
						"no-console": 0,
						"no-unused-vars": 2,
					},
				},
			});
			const file = getFixturePath("cli-engine", "console.js");

			assert(
				shell.test("-f", cacheFilePath),
				"the cache for eslint should exist",
			);

			await eslint.lintFiles([file]);

			assert(
				!shell.test("-f", cacheFilePath),
				"the cache for eslint should have been deleted",
			);
		});

		it("should use the specified cache file", async () => {
			cacheFilePath = path.resolve(".cache/custom-cache");
			doDelete(cacheFilePath);
			assert(
				!shell.test("-f", cacheFilePath),
				"the cache file already exists and wasn't successfully deleted",
			);

			eslint = new ESLint({
				overrideConfigFile: true,

				// specify a custom cache file
				cacheLocation: cacheFilePath,

				// specifying cache true the cache will be created
				cache: true,
				overrideConfig: {
					rules: {
						"no-console": 0,
						"no-unused-vars": 2,
					},
				},

				cwd: path.join(fixtureDir, ".."),
			});
			const badFile = fs.realpathSync(
				getFixturePath("cache/src", "fail-file.js"),
			);
			const goodFile = fs.realpathSync(
				getFixturePath("cache/src", "test-file.js"),
			);
			const result = await eslint.lintFiles([badFile, goodFile]);

			assert(
				shell.test("-f", cacheFilePath),
				"the cache for eslint should have been created",
			);

			const fileCache = fCache.createFromFile(cacheFilePath);
			const { cache } = fileCache;

			assert(
				typeof cache.getKey(goodFile) === "object",
				"the entry for the good file should have been in the cache",
			);
			assert(
				typeof cache.getKey(badFile) === "object",
				"the entry for the bad file should have been in the cache",
			);

			const cachedResult = await eslint.lintFiles([badFile, goodFile]);

			assert.deepStrictEqual(
				result,
				cachedResult,
				"result should be the same with or without cache",
			);
		});

		// https://github.com/eslint/eslint/issues/13507
		it("should not store `usedDeprecatedRules` in the cache file", async () => {
			cacheFilePath = getFixturePath(".eslintcache");
			doDelete(cacheFilePath);
			assert(
				!shell.test("-f", cacheFilePath),
				"the cache file already exists and wasn't successfully deleted",
			);

			const deprecatedRuleId = "space-in-parens";

			eslint = new ESLint({
				cwd: path.join(fixtureDir, ".."),
				overrideConfigFile: true,

				// specifying cache true the cache will be created
				cache: true,
				cacheLocation: cacheFilePath,
				overrideConfig: {
					rules: {
						[deprecatedRuleId]: 2,
					},
				},
			});

			const filePath = fs.realpathSync(
				getFixturePath("cache/src", "test-file.js"),
			);

			/*
			 * Run linting on the same file 3 times to cover multiple cases:
			 *   Run 1: Lint result wasn't already cached.
			 *   Run 2: Lint result was already cached. The cached lint result is used but the cache is reconciled before the run ends.
			 *   Run 3: Lint result was already cached. The cached lint result was being used throughout the previous run, so possible
			 *     mutations in the previous run that occured after the cache was reconciled may have side effects for this run.
			 */
			for (let i = 0; i < 3; i++) {
				const [result] = await eslint.lintFiles([filePath]);

				assert(
					result.usedDeprecatedRules &&
						result.usedDeprecatedRules.some(
							rule => rule.ruleId === deprecatedRuleId,
						),
					"the deprecated rule should have been in result.usedDeprecatedRules",
				);

				assert(
					shell.test("-f", cacheFilePath),
					"the cache for eslint should have been created",
				);

				const fileCache = fCache.create(cacheFilePath);
				const descriptor = fileCache.getFileDescriptor(filePath);

				assert(
					typeof descriptor === "object",
					"an entry for the file should have been in the cache file",
				);
				assert(
					typeof descriptor.meta.results === "object",
					"lint result for the file should have been in its cache entry in the cache file",
				);
				assert(
					typeof descriptor.meta.results.usedDeprecatedRules ===
						"undefined",
					"lint result in the cache file contains `usedDeprecatedRules`",
				);
			}
		});

		// https://github.com/eslint/eslint/issues/13507
		it("should store `source` as `null` in the cache file if the lint result has `source` property", async () => {
			cacheFilePath = getFixturePath(".eslintcache");
			doDelete(cacheFilePath);
			assert(
				!shell.test("-f", cacheFilePath),
				"the cache file already exists and wasn't successfully deleted",
			);

			eslint = new ESLint({
				cwd: path.join(fixtureDir, ".."),
				overrideConfigFile: true,

				// specifying cache true the cache will be created
				cache: true,
				cacheLocation: cacheFilePath,
				overrideConfig: {
					rules: {
						"no-unused-vars": 2,
					},
				},
			});

			const filePath = fs.realpathSync(
				getFixturePath("cache/src", "fail-file.js"),
			);

			/*
			 * Run linting on the same file 3 times to cover multiple cases:
			 *   Run 1: Lint result wasn't already cached.
			 *   Run 2: Lint result was already cached. The cached lint result is used but the cache is reconciled before the run ends.
			 *   Run 3: Lint result was already cached. The cached lint result was being used throughout the previous run, so possible
			 *     mutations in the previous run that occured after the cache was reconciled may have side effects for this run.
			 */
			for (let i = 0; i < 3; i++) {
				const [result] = await eslint.lintFiles([filePath]);

				assert(
					typeof result.source === "string",
					"the result should have contained the `source` property",
				);

				assert(
					shell.test("-f", cacheFilePath),
					"the cache for eslint should have been created",
				);

				const fileCache = fCache.create(cacheFilePath);
				const descriptor = fileCache.getFileDescriptor(filePath);

				assert(
					typeof descriptor === "object",
					"an entry for the file should have been in the cache file",
				);
				assert(
					typeof descriptor.meta.results === "object",
					"lint result for the file should have been in its cache entry in the cache file",
				);

				// if the lint result contains `source`, it should be stored as `null` in the cache file
				assert.strictEqual(
					descriptor.meta.results.source,
					null,
					"lint result in the cache file contains non-null `source`",
				);
			}
		});

		describe("cacheStrategy", () => {
			it("should detect changes using a file's modification time when set to 'metadata'", async () => {
				cacheFilePath = getFixturePath(".eslintcache");
				doDelete(cacheFilePath);
				assert(
					!shell.test("-f", cacheFilePath),
					"the cache file already exists and wasn't successfully deleted",
				);

				eslint = new ESLint({
					cwd: path.join(fixtureDir, ".."),
					overrideConfigFile: true,

					// specifying cache true the cache will be created
					cache: true,
					cacheLocation: cacheFilePath,
					cacheStrategy: "metadata",
					overrideConfig: {
						rules: {
							"no-console": 0,
							"no-unused-vars": 2,
						},
					},
				});
				const badFile = fs.realpathSync(
					getFixturePath("cache/src", "fail-file.js"),
				);
				const goodFile = fs.realpathSync(
					getFixturePath("cache/src", "test-file.js"),
				);

				await eslint.lintFiles([badFile, goodFile]);
				let fileCache = fCache.createFromFile(cacheFilePath);
				const entries = fileCache.normalizeEntries([badFile, goodFile]);

				entries.forEach(entry => {
					assert(
						entry.changed === false,
						`the entry for ${entry.key} should have been initially unchanged`,
					);
				});

				// this should result in a changed entry
				shell.touch(goodFile);
				fileCache = fCache.createFromFile(cacheFilePath);
				assert(
					fileCache.getFileDescriptor(badFile).changed === false,
					`the entry for ${badFile} should have been unchanged`,
				);
				assert(
					fileCache.getFileDescriptor(goodFile).changed === true,
					`the entry for ${goodFile} should have been changed`,
				);
			});

			it("should not detect changes using a file's modification time when set to 'content'", async () => {
				cacheFilePath = getFixturePath(".eslintcache");
				doDelete(cacheFilePath);
				assert(
					!shell.test("-f", cacheFilePath),
					"the cache file already exists and wasn't successfully deleted",
				);

				eslint = new ESLint({
					cwd: path.join(fixtureDir, ".."),
					overrideConfigFile: true,

					// specifying cache true the cache will be created
					cache: true,
					cacheLocation: cacheFilePath,
					cacheStrategy: "content",
					overrideConfig: {
						rules: {
							"no-console": 0,
							"no-unused-vars": 2,
						},
					},
				});
				const badFile = fs.realpathSync(
					getFixturePath("cache/src", "fail-file.js"),
				);
				const goodFile = fs.realpathSync(
					getFixturePath("cache/src", "test-file.js"),
				);

				await eslint.lintFiles([badFile, goodFile]);
				let fileCache = fCache.createFromFile(cacheFilePath, true);
				let entries = fileCache.normalizeEntries([badFile, goodFile]);

				entries.forEach(entry => {
					assert(
						entry.changed === false,
						`the entry for ${entry.key} should have been initially unchanged`,
					);
				});

				// this should NOT result in a changed entry
				shell.touch(goodFile);
				fileCache = fCache.createFromFile(cacheFilePath, true);
				entries = fileCache.normalizeEntries([badFile, goodFile]);
				entries.forEach(entry => {
					assert(
						entry.changed === false,
						`the entry for ${entry.key} should have remained unchanged`,
					);
				});
			});

			it("should detect changes using a file's contents when set to 'content'", async () => {
				cacheFilePath = getFixturePath(".eslintcache");
				doDelete(cacheFilePath);
				assert(
					!shell.test("-f", cacheFilePath),
					"the cache file already exists and wasn't successfully deleted",
				);

				eslint = new ESLint({
					cwd: path.join(fixtureDir, ".."),
					overrideConfigFile: true,

					// specifying cache true the cache will be created
					cache: true,
					cacheLocation: cacheFilePath,
					cacheStrategy: "content",
					overrideConfig: {
						rules: {
							"no-console": 0,
							"no-unused-vars": 2,
						},
					},
				});
				const badFile = fs.realpathSync(
					getFixturePath("cache/src", "fail-file.js"),
				);
				const goodFile = fs.realpathSync(
					getFixturePath("cache/src", "test-file.js"),
				);
				const goodFileCopy = path.resolve(
					`${path.dirname(goodFile)}`,
					"test-file-copy.js",
				);

				shell.cp(goodFile, goodFileCopy);

				await eslint.lintFiles([badFile, goodFileCopy]);
				let fileCache = fCache.createFromFile(cacheFilePath, true);
				const entries = fileCache.normalizeEntries([
					badFile,
					goodFileCopy,
				]);

				entries.forEach(entry => {
					assert(
						entry.changed === false,
						`the entry for ${entry.key} should have been initially unchanged`,
					);
				});

				// this should result in a changed entry
				shell.sed("-i", "abc", "xzy", goodFileCopy);
				fileCache = fCache.createFromFile(cacheFilePath, true);
				assert(
					fileCache.getFileDescriptor(badFile).changed === false,
					`the entry for ${badFile} should have been unchanged`,
				);
				assert(
					fileCache.getFileDescriptor(goodFileCopy).changed === true,
					`the entry for ${goodFileCopy} should have been changed`,
				);
			});
		});
	});

	describe("v10_config_lookup_from_file", () => {
		let eslint;
		const flags = ["v10_config_lookup_from_file"];

		it("should report zero messages when given a config file and a valid file", async () => {
			/*
			 * This test ensures subdir/code.js is linted using the configuration in
			 * subdir/eslint.config.js and not from eslint.config.js in the parent
			 * directory.
			 */

			eslint = new ESLint({
				flags,
				cwd: getFixturePath("lookup-from-file"),
			});
			const results = await eslint.lintFiles(["."]);

			assert.strictEqual(results.length, 2);
			assert.strictEqual(
				results[0].filePath,
				getFixturePath("lookup-from-file", "code.js"),
			);
			assert.strictEqual(results[0].messages.length, 1);
			assert.strictEqual(results[0].messages[0].ruleId, "no-unused-vars");
			assert.strictEqual(results[0].messages[0].severity, 2);
			assert.strictEqual(results[0].suppressedMessages.length, 0);

			assert.strictEqual(
				results[1].filePath,
				getFixturePath("lookup-from-file", "subdir", "code.js"),
			);
			assert.strictEqual(results[1].messages.length, 1);
			assert.strictEqual(results[1].messages[0].ruleId, "no-unused-vars");
			assert.strictEqual(results[1].messages[0].severity, 1);
			assert.strictEqual(results[1].suppressedMessages.length, 0);
		});

		describe("Subdirectory Config File", () => {
			const workDirName = "subdir-only-config";
			const tmpDir = path.resolve(fs.realpathSync(os.tmpdir()), "eslint");
			const workDir = path.join(tmpDir, workDirName);

			// copy into clean area so as not to get "infected" by other config files
			before(() => {
				shell.mkdir("-p", workDir);
				shell.cp("-r", `./tests/fixtures/${workDirName}`, tmpDir);
			});

			after(() => {
				shell.rm("-r", workDir);
			});

			it("should find config file when cwd doesn't have a config file", async () => {
				eslint = new ESLint({
					flags,
					cwd: workDir,
				});
				const results = await eslint.lintFiles(["."]);

				assert.strictEqual(results.length, 1);
				assert.strictEqual(
					results[0].filePath,
					path.resolve(workDir, "subdir", "eslint.config.mjs"),
				);
				assert.strictEqual(results[0].messages.length, 1);
				assert.strictEqual(
					results[0].messages[0].ruleId,
					"no-unused-vars",
				);
				assert.strictEqual(results[0].messages[0].severity, 2);
				assert.strictEqual(results[0].suppressedMessages.length, 0);
			});
		});

		describe("Root config trying to ignore subdirectory pattern with config", () => {
			const workDirName = "config-lookup-ignores";
			const tmpDir = path.resolve(fs.realpathSync(os.tmpdir()), "eslint");
			const workDir = path.join(tmpDir, workDirName);

			// copy into clean area so as not to get "infected" by other config files
			before(() => {
				shell.mkdir("-p", workDir);
				shell.cp("-r", `./tests/fixtures/${workDirName}`, tmpDir);
			});

			after(() => {
				shell.rm("-r", workDir);
			});

			it("should not traverse into subdir1 when parent config file specifies it as ignored and passing in .", async () => {
				eslint = new ESLint({
					flags,
					cwd: workDir,
				});
				const results = await eslint.lintFiles(["."]);

				assert.strictEqual(results.length, 1);
				assert.strictEqual(
					results[0].filePath,
					path.resolve(workDir, "eslint.config.cjs"),
				);
				assert.strictEqual(results[0].messages.length, 0);
				assert.strictEqual(results[0].suppressedMessages.length, 0);
			});

			it("should not traverse into subdir1 when parent config file specifies it as ignored and passing in *", async () => {
				eslint = new ESLint({
					flags,
					cwd: workDir,
				});
				const results = await eslint.lintFiles(["*"]);

				assert.strictEqual(results.length, 1);
				assert.strictEqual(
					results[0].filePath,
					path.resolve(workDir, "eslint.config.cjs"),
				);
				assert.strictEqual(results[0].messages.length, 0);
				assert.strictEqual(results[0].suppressedMessages.length, 0);
			});

			it("should traverse into subdir1 when parent config file specifies it as ignored and passing in subdir1", async () => {
				eslint = new ESLint({
					flags,
					cwd: workDir,
				});
				const results = await eslint.lintFiles(["subdir1"]);

				assert.strictEqual(results.length, 1);
				assert.strictEqual(
					results[0].filePath,
					path.resolve(workDir, "subdir1", "eslint.config.mjs"),
				);
				assert.strictEqual(results[0].messages.length, 1);
				assert.strictEqual(
					results[0].messages[0].ruleId,
					"no-unused-vars",
				);
				assert.strictEqual(results[0].suppressedMessages.length, 0);
			});

			it("should traverse into subdir1 when parent config file specifies it as ignored and passing in subdir1/*.mjs", async () => {
				eslint = new ESLint({
					flags,
					cwd: workDir,
				});
				const results = await eslint.lintFiles(["subdir1/*.mjs"]);

				assert.strictEqual(results.length, 1);
				assert.strictEqual(
					results[0].filePath,
					path.resolve(workDir, "subdir1", "eslint.config.mjs"),
				);
				assert.strictEqual(results[0].messages.length, 1);
				assert.strictEqual(
					results[0].messages[0].ruleId,
					"no-unused-vars",
				);
				assert.strictEqual(results[0].suppressedMessages.length, 0);
			});

			it("should reject an error when parent config file specifies subdir1 as ignored and passing in sub*1/*.mjs", async () => {
				eslint = new ESLint({
					flags,
					cwd: workDir,
				});

				return assert.rejects(
					() => eslint.lintFiles(["sub*1/*.mjs"]),
					/All files matched by 'sub\*1\/\*.mjs' are ignored\./u,
				);
			});

			it("should traverse into subdir1 when parent config file specifies it as ignored and passing in subdir1/eslint.config.mjs", async () => {
				eslint = new ESLint({
					flags,
					cwd: workDir,
				});
				const results = await eslint.lintFiles([
					"subdir1/eslint.config.mjs",
				]);

				assert.strictEqual(results.length, 1);
				assert.strictEqual(
					results[0].filePath,
					path.resolve(workDir, "subdir1", "eslint.config.mjs"),
				);
				assert.strictEqual(results[0].messages.length, 1);
				assert.strictEqual(
					results[0].messages[0].ruleId,
					"no-unused-vars",
				);
				assert.strictEqual(results[0].suppressedMessages.length, 0);
			});

			it("should traverse into subdir1 when parent config file specifies it as ignored and passing in ../subdir1/eslint.config.mjs", async () => {
				eslint = new ESLint({
					flags,
					cwd: path.resolve(workDir, "subdir2"),
				});
				const results = await eslint.lintFiles([
					"../subdir1/eslint.config.mjs",
				]);

				assert.strictEqual(results.length, 1);
				assert.strictEqual(
					results[0].filePath,
					path.resolve(workDir, "subdir1", "eslint.config.mjs"),
				);
				assert.strictEqual(results[0].messages.length, 1);
				assert.strictEqual(
					results[0].messages[0].ruleId,
					"no-unused-vars",
				);
				assert.strictEqual(results[0].suppressedMessages.length, 0);
			});

			it("should traverse into subdir1 when parent config file specifies it as ignored and passing in ../subdir1/*.mjs", async () => {
				eslint = new ESLint({
					flags,
					cwd: path.resolve(workDir, "subdir2"),
				});
				const results = await eslint.lintFiles(["../subdir1/*.mjs"]);

				assert.strictEqual(results.length, 1);
				assert.strictEqual(
					results[0].filePath,
					path.resolve(workDir, "subdir1", "eslint.config.mjs"),
				);
				assert.strictEqual(results[0].messages.length, 1);
				assert.strictEqual(
					results[0].messages[0].ruleId,
					"no-unused-vars",
				);
				assert.strictEqual(results[0].suppressedMessages.length, 0);
			});

			it("should traverse into subdir1 when parent config file specifies it as ignored and passing in ../subdir1", async () => {
				eslint = new ESLint({
					flags,
					cwd: path.resolve(workDir, "subdir2"),
				});
				const results = await eslint.lintFiles(["../subdir1"]);

				assert.strictEqual(results.length, 1);
				assert.strictEqual(
					results[0].filePath,
					path.resolve(workDir, "subdir1", "eslint.config.mjs"),
				);
				assert.strictEqual(results[0].messages.length, 1);
				assert.strictEqual(
					results[0].messages[0].ruleId,
					"no-unused-vars",
				);
				assert.strictEqual(results[0].suppressedMessages.length, 0);
			});

			it("should traverse into subdir3/subsubdir when parent config file specifies it as ignored and passing in subdir3/subsubdir", async () => {
				eslint = new ESLint({
					flags,
					cwd: workDir,
				});
				const results = await eslint.lintFiles(["subdir3/subsubdir"]);

				assert.strictEqual(results.length, 1);
				assert.strictEqual(
					results[0].filePath,
					path.resolve(
						workDir,
						"subdir3",
						"subsubdir",
						"eslint.config.mjs",
					),
				);
				assert.strictEqual(results[0].messages.length, 1);
				assert.strictEqual(
					results[0].messages[0].ruleId,
					"no-unused-vars",
				);
				assert.strictEqual(results[0].suppressedMessages.length, 0);
			});
		});

		describe("Root config trying to ignore specific subdirectory with config", () => {
			const workDirName = "config-lookup-ignores-2";
			const tmpDir = path.resolve(fs.realpathSync(os.tmpdir()), "eslint");
			const workDir = path.join(tmpDir, workDirName);

			// copy into clean area so as not to get "infected" by other config files
			before(() => {
				shell.mkdir("-p", workDir);
				shell.cp("-r", `./tests/fixtures/${workDirName}`, tmpDir);
			});

			after(() => {
				shell.rm("-r", workDir);
			});

			it("should traverse into subdir1 and subdir2 but not subdir3 when parent config file specifies it as ignored and passing in .", async () => {
				eslint = new ESLint({
					flags,
					cwd: workDir,
				});
				const results = await eslint.lintFiles(["."]);

				assert.strictEqual(results.length, 3);
				assert.strictEqual(
					results[0].filePath,
					path.resolve(workDir, "eslint.config.cjs"),
				);
				assert.strictEqual(results[0].messages.length, 1);
				assert.strictEqual(
					results[0].messages[0].ruleId,
					"no-unused-vars",
				);
				assert.strictEqual(results[0].messages[0].severity, 1);
				assert.strictEqual(results[0].suppressedMessages.length, 0);
				assert.strictEqual(
					results[1].filePath,
					path.resolve(workDir, "subdir1/1.js"),
				);
				assert.strictEqual(results[1].messages.length, 1);
				assert.strictEqual(
					results[1].messages[0].ruleId,
					"no-unused-vars",
				);
				assert.strictEqual(results[1].messages[0].severity, 1);
				assert.strictEqual(results[1].suppressedMessages.length, 0);
				assert.strictEqual(
					results[2].filePath,
					path.resolve(workDir, "subdir2/2.js"),
				);
				assert.strictEqual(results[2].messages.length, 1);
				assert.strictEqual(
					results[2].messages[0].ruleId,
					"no-unused-vars",
				);
				assert.strictEqual(results[2].messages[0].severity, 1);
				assert.strictEqual(results[2].suppressedMessages.length, 0);
			});

			it("should not traverse into subdirectories when passing in *", async () => {
				eslint = new ESLint({
					flags,
					cwd: workDir,
				});
				const results = await eslint.lintFiles(["*"]);

				assert.strictEqual(results.length, 1);
				assert.strictEqual(
					results[0].filePath,
					path.resolve(workDir, "eslint.config.cjs"),
				);
				assert.strictEqual(results[0].messages.length, 1);
				assert.strictEqual(
					results[0].messages[0].ruleId,
					"no-unused-vars",
				);
				assert.strictEqual(results[0].messages[0].severity, 1);
				assert.strictEqual(results[0].suppressedMessages.length, 0);
			});

			it("should traverse into subdir3 when parent config file specifies it as ignored and passing in subdir3", async () => {
				eslint = new ESLint({
					flags,
					cwd: workDir,
				});
				const results = await eslint.lintFiles(["subdir3"]);

				assert.strictEqual(results.length, 2);
				assert.strictEqual(
					results[0].filePath,
					path.resolve(workDir, "subdir3/3.js"),
				);
				assert.strictEqual(results[0].messages.length, 1);
				assert.strictEqual(
					results[0].messages[0].ruleId,
					"no-unused-vars",
				);
				assert.strictEqual(results[0].messages[0].severity, 2);
				assert.strictEqual(results[0].suppressedMessages.length, 0);
				assert.strictEqual(
					results[1].filePath,
					path.resolve(workDir, "subdir3/eslint.config.mjs"),
				);
				assert.strictEqual(results[1].messages.length, 0);
				assert.strictEqual(results[1].suppressedMessages.length, 0);
			});

			it("should traverse into subdir3 when parent config file specifies it as ignored and passing in subdir3/*.js", async () => {
				eslint = new ESLint({
					flags,
					cwd: workDir,
				});
				const results = await eslint.lintFiles(["subdir3/*.js"]);

				assert.strictEqual(results.length, 1);
				assert.strictEqual(
					results[0].filePath,
					path.resolve(workDir, "subdir3/3.js"),
				);
				assert.strictEqual(results[0].messages.length, 1);
				assert.strictEqual(
					results[0].messages[0].ruleId,
					"no-unused-vars",
				);
				assert.strictEqual(results[0].messages[0].severity, 2);
				assert.strictEqual(results[0].suppressedMessages.length, 0);
			});

			it("should lint files in subdir3 and eslint.config.cjs when parent config file specifies subdir3 as ignored and passing in subdir3/*.js, **/*.cjs", async () => {
				eslint = new ESLint({
					flags,
					cwd: workDir,
				});
				const results = await eslint.lintFiles([
					"subdir3/*.js",
					"**/*.cjs",
				]);

				assert.strictEqual(results.length, 2);
				assert.strictEqual(
					results[0].filePath,
					path.resolve(workDir, "eslint.config.cjs"),
				);
				assert.strictEqual(results[0].messages.length, 1);
				assert.strictEqual(
					results[0].messages[0].ruleId,
					"no-unused-vars",
				);
				assert.strictEqual(results[0].messages[0].severity, 1);
				assert.strictEqual(results[0].suppressedMessages.length, 0);
				assert.strictEqual(
					results[1].filePath,
					path.resolve(workDir, "subdir3/3.js"),
				);
				assert.strictEqual(results[1].messages.length, 1);
				assert.strictEqual(
					results[1].messages[0].ruleId,
					"no-unused-vars",
				);
				assert.strictEqual(results[1].messages[0].severity, 2);
				assert.strictEqual(results[1].suppressedMessages.length, 0);
			});

			it("should lint files in subdir3 and eslint.config.cjs when parent config file specifies subdir3 as ignored and passing in **/*.cjs, subdir3/*.js", async () => {
				eslint = new ESLint({
					flags,
					cwd: workDir,
				});
				const results = await eslint.lintFiles([
					"**/*.cjs",
					"subdir3/*.js",
				]);

				assert.strictEqual(results.length, 2);
				assert.strictEqual(
					results[0].filePath,
					path.resolve(workDir, "eslint.config.cjs"),
				);
				assert.strictEqual(results[0].messages.length, 1);
				assert.strictEqual(
					results[0].messages[0].ruleId,
					"no-unused-vars",
				);
				assert.strictEqual(results[0].messages[0].severity, 1);
				assert.strictEqual(results[0].suppressedMessages.length, 0);
				assert.strictEqual(
					results[1].filePath,
					path.resolve(workDir, "subdir3/3.js"),
				);
				assert.strictEqual(results[1].messages.length, 1);
				assert.strictEqual(
					results[1].messages[0].ruleId,
					"no-unused-vars",
				);
				assert.strictEqual(results[1].messages[0].severity, 2);
				assert.strictEqual(results[1].suppressedMessages.length, 0);
			});

			it("should traverse into subdir1 and subdir2 but not subdir3 when parent config file specifies it as ignored and passing in sub*/*.js", async () => {
				eslint = new ESLint({
					flags,
					cwd: workDir,
				});
				const results = await eslint.lintFiles(["sub*/*.js"]);

				assert.strictEqual(results.length, 2);
				assert.strictEqual(
					results[0].filePath,
					path.resolve(workDir, "subdir1/1.js"),
				);
				assert.strictEqual(results[0].messages.length, 1);
				assert.strictEqual(
					results[0].messages[0].ruleId,
					"no-unused-vars",
				);
				assert.strictEqual(results[0].messages[0].severity, 1);
				assert.strictEqual(results[0].suppressedMessages.length, 0);
				assert.strictEqual(
					results[1].filePath,
					path.resolve(workDir, "subdir2/2.js"),
				);
				assert.strictEqual(results[1].messages.length, 1);
				assert.strictEqual(
					results[1].messages[0].ruleId,
					"no-unused-vars",
				);
				assert.strictEqual(results[1].messages[0].severity, 1);
				assert.strictEqual(results[1].suppressedMessages.length, 0);
			});

			it("should reject an error when parent config file specifies subdir3 as ignored and passing in sub*3/*.mjs", async () => {
				eslint = new ESLint({
					flags,
					cwd: workDir,
				});

				return assert.rejects(
					() => eslint.lintFiles(["sub*3/*.mjs"]),
					/All files matched by 'sub\*3\/\*\.mjs' are ignored\./u,
				);
			});

			it("should traverse into subdir1 and subdir2 but not subdir3 when parent config file specifies it as ignored and passing in sub*/*.js and **/*.cjs", async () => {
				eslint = new ESLint({
					flags,
					cwd: workDir,
				});
				const results = await eslint.lintFiles([
					"sub*/*.js",
					"**/*.cjs",
				]);

				assert.strictEqual(results.length, 3);
				assert.strictEqual(
					results[0].filePath,
					path.resolve(workDir, "eslint.config.cjs"),
				);
				assert.strictEqual(results[0].messages.length, 1);
				assert.strictEqual(
					results[0].messages[0].ruleId,
					"no-unused-vars",
				);
				assert.strictEqual(results[0].messages[0].severity, 1);
				assert.strictEqual(results[0].suppressedMessages.length, 0);
				assert.strictEqual(
					results[1].filePath,
					path.resolve(workDir, "subdir1/1.js"),
				);
				assert.strictEqual(results[1].messages.length, 1);
				assert.strictEqual(
					results[1].messages[0].ruleId,
					"no-unused-vars",
				);
				assert.strictEqual(results[1].messages[0].severity, 1);
				assert.strictEqual(results[1].suppressedMessages.length, 0);
				assert.strictEqual(
					results[2].filePath,
					path.resolve(workDir, "subdir2/2.js"),
				);
				assert.strictEqual(results[2].messages.length, 1);
				assert.strictEqual(
					results[2].messages[0].ruleId,
					"no-unused-vars",
				);
				assert.strictEqual(results[2].messages[0].severity, 1);
				assert.strictEqual(results[2].suppressedMessages.length, 0);
			});

			it("should traverse into subdir1 and subdir2 but not subdir3 when parent config file specifies it as ignored and passing in **/*.cjs and sub*/*.js", async () => {
				eslint = new ESLint({
					flags,
					cwd: workDir,
				});
				const results = await eslint.lintFiles([
					"**/*.cjs",
					"sub*/*.js",
				]);

				assert.strictEqual(results.length, 3);
				assert.strictEqual(
					results[0].filePath,
					path.resolve(workDir, "eslint.config.cjs"),
				);
				assert.strictEqual(results[0].messages.length, 1);
				assert.strictEqual(
					results[0].messages[0].ruleId,
					"no-unused-vars",
				);
				assert.strictEqual(results[0].messages[0].severity, 1);
				assert.strictEqual(results[0].suppressedMessages.length, 0);
				assert.strictEqual(
					results[1].filePath,
					path.resolve(workDir, "subdir1/1.js"),
				);
				assert.strictEqual(results[1].messages.length, 1);
				assert.strictEqual(
					results[1].messages[0].ruleId,
					"no-unused-vars",
				);
				assert.strictEqual(results[1].messages[0].severity, 1);
				assert.strictEqual(results[1].suppressedMessages.length, 0);
				assert.strictEqual(
					results[2].filePath,
					path.resolve(workDir, "subdir2/2.js"),
				);
				assert.strictEqual(results[2].messages.length, 1);
				assert.strictEqual(
					results[2].messages[0].ruleId,
					"no-unused-vars",
				);
				assert.strictEqual(results[2].messages[0].severity, 1);
				assert.strictEqual(results[2].suppressedMessages.length, 0);
			});

			it("should traverse into subdir3 when parent config file specifies it as ignored and passing in subdir3/eslint.config.mjs", async () => {
				eslint = new ESLint({
					flags,
					cwd: workDir,
				});
				const results = await eslint.lintFiles([
					"subdir3/eslint.config.mjs",
				]);

				assert.strictEqual(results.length, 1);
				assert.strictEqual(
					results[0].filePath,
					path.resolve(workDir, "subdir3", "eslint.config.mjs"),
				);
				assert.strictEqual(results[0].messages.length, 0);
				assert.strictEqual(results[0].suppressedMessages.length, 0);
			});

			it("should traverse into subdir3 when parent config file specifies it as ignored and passing in ../subdir3/eslint.config.mjs", async () => {
				eslint = new ESLint({
					flags,
					cwd: path.resolve(workDir, "subdir2"),
				});
				const results = await eslint.lintFiles([
					"../subdir3/eslint.config.mjs",
				]);

				assert.strictEqual(results.length, 1);
				assert.strictEqual(
					results[0].filePath,
					path.resolve(workDir, "subdir3", "eslint.config.mjs"),
				);
				assert.strictEqual(results[0].messages.length, 0);
				assert.strictEqual(results[0].suppressedMessages.length, 0);
			});

			it("should traverse into subdir3 when parent config file specifies it as ignored and passing in ../subdir3/*.mjs", async () => {
				eslint = new ESLint({
					flags,
					cwd: path.resolve(workDir, "subdir2"),
				});
				const results = await eslint.lintFiles(["../subdir3/*.mjs"]);

				assert.strictEqual(results.length, 1);
				assert.strictEqual(
					results[0].filePath,
					path.resolve(workDir, "subdir3", "eslint.config.mjs"),
				);
				assert.strictEqual(results[0].messages.length, 0);
				assert.strictEqual(results[0].suppressedMessages.length, 0);
			});

			it("should traverse into subdir3 when parent config file specifies it as ignored and passing in ../subdir3", async () => {
				eslint = new ESLint({
					flags,
					cwd: path.resolve(workDir, "subdir2"),
				});
				const results = await eslint.lintFiles(["../subdir3"]);

				assert.strictEqual(results.length, 2);
				assert.strictEqual(
					results[0].filePath,
					path.resolve(workDir, "subdir3/3.js"),
				);
				assert.strictEqual(results[0].messages.length, 1);
				assert.strictEqual(
					results[0].messages[0].ruleId,
					"no-unused-vars",
				);
				assert.strictEqual(results[0].messages[0].severity, 2);
				assert.strictEqual(results[0].suppressedMessages.length, 0);
				assert.strictEqual(
					results[1].filePath,
					path.resolve(workDir, "subdir3/eslint.config.mjs"),
				);
				assert.strictEqual(results[1].messages.length, 0);
				assert.strictEqual(results[1].suppressedMessages.length, 0);
			});
		});

		describe("with `ignorePatterns`", () => {
			const workDirName = "config-lookup-ignores-3";
			const tmpDir = path.resolve(fs.realpathSync(os.tmpdir()), "eslint");
			const workDir = path.join(tmpDir, workDirName);

			// copy into clean area so as not to get "infected" by other config files
			before(() => {
				shell.mkdir("-p", workDir);
				shell.cp("-r", `./tests/fixtures/${workDirName}`, tmpDir);
			});

			after(() => {
				shell.rm("-r", workDir);
			});

			// https://github.com/eslint/eslint/issues/18948
			it("should interpret `ignorePatterns` as relative to `cwd` when `cwd` is a parent directory.", async () => {
				eslint = new ESLint({
					flags,
					cwd: workDir,
					ignorePatterns: ["subdir/b.js"],
				});
				const results = await eslint.lintFiles(["subdir"]);

				assert.strictEqual(results.length, 2);
				assert.strictEqual(
					results[0].filePath,
					path.resolve(workDir, "subdir/a.js"),
				);
				assert.strictEqual(results[0].messages.length, 1);
				assert.strictEqual(
					results[0].messages[0].ruleId,
					"no-unused-vars",
				);
				assert.strictEqual(results[0].suppressedMessages.length, 0);
				assert.strictEqual(
					results[1].filePath,
					path.resolve(workDir, "subdir/eslint.config.mjs"),
				);
				assert.strictEqual(results[1].messages.length, 0);
				assert.strictEqual(results[1].suppressedMessages.length, 0);
			});
		});
	});

	// A test copied from the `v10_config_lookup_from_file` tests to ensure the `unstable_config_lookup_from_file` flag still works
	describe("unstable_config_lookup_from_file", () => {
		let processStub;

		beforeEach(() => {
			sinon.restore();
			processStub = sinon
				.stub(process, "emitWarning")
				.withArgs(sinon.match.any, sinon.match(/^ESLintInactiveFlag_/u))
				.returns();
		});

		it("should report zero messages when given a config file and a valid file", async () => {
			/*
			 * This test ensures subdir/code.js is linted using the configuration in
			 * subdir/eslint.config.js and not from eslint.config.js in the parent
			 * directory.
			 */

			const eslint = new ESLint({
				flags: ["unstable_config_lookup_from_file"],
				cwd: getFixturePath("lookup-from-file"),
			});
			const results = await eslint.lintFiles(["."]);

			assert.strictEqual(results.length, 2);
			assert.strictEqual(
				results[0].filePath,
				getFixturePath("lookup-from-file", "code.js"),
			);
			assert.strictEqual(results[0].messages.length, 1);
			assert.strictEqual(results[0].messages[0].ruleId, "no-unused-vars");
			assert.strictEqual(results[0].messages[0].severity, 2);
			assert.strictEqual(results[0].suppressedMessages.length, 0);

			assert.strictEqual(
				results[1].filePath,
				getFixturePath("lookup-from-file", "subdir", "code.js"),
			);
			assert.strictEqual(results[1].messages.length, 1);
			assert.strictEqual(results[1].messages[0].ruleId, "no-unused-vars");
			assert.strictEqual(results[1].messages[0].severity, 1);
			assert.strictEqual(results[1].suppressedMessages.length, 0);

			assert.strictEqual(
				processStub.callCount,
				1,
				"calls `process.emitWarning()` for flags once",
			);
			assert.deepStrictEqual(processStub.getCall(0).args, [
				"The flag 'unstable_config_lookup_from_file' is inactive: This flag has been renamed 'v10_config_lookup_from_file' to reflect its stabilization. Please use 'v10_config_lookup_from_file' instead.",
				"ESLintInactiveFlag_unstable_config_lookup_from_file",
			]);
		});
	});
});
