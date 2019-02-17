import * as fs from "fs";
import {
  DescribeBlock,
  ItBlock,
  parse,
  ParsedNode,
  ParsedNodeTypes,
  ProjectWorkspace,
  Settings,
} from "jest-editor-support";
import * as mm from "micromatch";
import * as path from "path";
import { EventEmitter } from "vscode";
import {
  TestInfo,
  TestLoadFinishedEvent,
  TestLoadStartedEvent,
  TestSuiteInfo,
} from "vscode-test-adapter-api";
import { Log } from "vscode-test-adapter-util";

type Matcher = (value: string) => boolean;

/**
 * Glob patterns to globally ignore when searching for tests.
 * Only universally recognized patterns should be used here, such as node_modules.
 */
const IGNORE_GLOBS = [
  "node_modules",
];

/**
 * Returns true if the specified path is a directory, false otherwise.
 * @param directory The full file system path to the check.
 */
function checkIsDirectory(directory: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    fs.stat(directory, (err, stats) => {
      if (err) {
        reject(err);
      } else {
        resolve(stats.isDirectory());
      }
    });
  });
}

/**
 * Creates a matcher function that returns true if a file should be explored for tests, false otherwise.
 * @param settings The Jest settings.
 */
function createMatcher(settings: Settings): Matcher {
  if (settings.settings.testRegex) {
    const regex = new RegExp(settings.settings.testRegex);
    return (value) => regex.test(value);
  } else {
    return (value) => mm.any(value, settings.settings.testMatch);
  }
}

/**
 * Explores a directory recursively and returns the TestSuiteInfo representing the directory.
 * @param directory The full file system path to the directory.
 * @param matcher The matcher function to use to determine if a file includes tests.
 */
async function exploreDirectory(directory: string, matcher: Matcher): Promise<TestSuiteInfo> {
  const contents = await getDirectoryContents(directory);
  const children = await Promise.all(contents.map((x) => evalueFilePath(x, matcher)));
  const filteredChildren = children
    .filter(Boolean)
    .filter((x) => (x as TestSuiteInfo).children.length > 0);
  return {
    children: filteredChildren,
    file: directory,
    id: directory,
    label: path.basename(directory),
    type: "suite",
  } as TestSuiteInfo;
}

/**
 * Evaluates a file path and returns the TestSuiteInfo representing it.
 * If the path is a directory, it will recursively explore it.
 * If the path is a file, it will parse the contents and search for test blocks.
 * If the directory or file did not include any tests, null will be returned.
 * @param filePath The file path to evaluate.
 * @param matcher The matcher function to use to determine if a file includes tests.
 */
async function evalueFilePath(filePath: string, matcher: Matcher): Promise<TestSuiteInfo | null> {
  const isDirectory = await checkIsDirectory(filePath);
  if (isDirectory) {
    const testSuite = await exploreDirectory(filePath, matcher);
    return testSuite.children.length > 0 ? testSuite : null;
  } else if (matcher(filePath)) {
    return exploreFile(filePath);
  } else {
    return null;
  }
}

/**
 * Explores a file by parsing the contents and returning a TestSuiteInfo representing the tests contained within.
 * @param file The file path to explore.
 */
function exploreFile(file: string): TestSuiteInfo {
  const parsedInfo = parse(file);
  const children = (parsedInfo.root.children || [])
    .map((x) => exploreNode(x, file, file))
    .filter(Boolean);
  return {
    children,
    file,
    id: file,
    label: path.basename(file),
    type: "suite",
  } as TestSuiteInfo;
}

/**
 * Recursively explores a node.
 * Returns a TestInfo if the node is an individual test.
 * Returns a TestSuiteInfo if the node is a group of tests, such as a describe block.
 * @param node The node to explore.
 * @param file The path of the file being explored.
 * @param prefix The test ID prefix.
 */
function exploreNode(node: ParsedNode, file: string, prefix: string): TestInfo | TestSuiteInfo | null {
  switch (node.type) {
    case ParsedNodeTypes.it:
      const it = node as ItBlock;
      return {
        file,
        id: path.join(file, prefix, it.name),
        label: it.name,
        line: it.start.line,
        type: "test",
      } as TestInfo;
    case ParsedNodeTypes.describe:
      const describe = node as DescribeBlock;
      const id = path.join(file, prefix, describe.name);
      const children = (describe.children || [])
        .map((x) => exploreNode(x, file, id))
        .filter(Boolean);
      return {
        children,
        file,
        id,
        label: describe.name,
        line: describe.start.line,
        type: "suite",
      } as TestSuiteInfo;
    default:
      return null;
  }
}

/**
 * Retrieves the contents of a directory and outputs their absolute paths.
 * Includes both files and directories.
 * Excludes glob patterns included in IGNORE_GLOBS.
 * @param directory Returns an array of absolute paths representing the items within the directory.
 */
function getDirectoryContents(directory: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    fs.readdir(directory, (err, files) => {
      if (err) {
        reject(err);
      } else {
        const includedFiles = mm.not(files, IGNORE_GLOBS);
        resolve(includedFiles.map((f) => path.join(directory, f)));
      }
    });
  });
}

export default class TestLoader {

  constructor(
    private readonly emitter: EventEmitter<TestLoadStartedEvent | TestLoadFinishedEvent>,
    private readonly log: Log,
    private readonly projectWorkspace: ProjectWorkspace,
  ) {
  }

  public async loadTests() {
    this.emitter.fire({
      type: "started",
    } as TestLoadStartedEvent);

    this.log.info(`Loading Jest settings from ${this.projectWorkspace.pathToConfig}`);
    const settings = new Settings(this.projectWorkspace);
    this.log.info("Jest settings loaded");

    this.log.info("Loading Jest tests");
    const matcher = createMatcher(settings);
    const testSuite = await exploreDirectory(this.projectWorkspace.rootPath, matcher);
    this.log.info("Test load complete");

    this.emitter.fire({
      suite: {
        children: testSuite.children,
        id: "root",
        label: "Jest",
        type: "suite",
      },
      type: "finished",
    } as TestLoadFinishedEvent);
  }

}
