import {
  IParseResults,
  JestAssertionResults,
  JestFileResults,
  TestAssertionStatus,
  TestReconciler,
} from "jest-editor-support";
import {
  TestDecoration,
  TestInfo,
  TestSuiteInfo,
} from "vscode-test-adapter-api";
import { TEST_ID_SEPARATOR } from "../constants";
import { IJestResponse, ITestFilter } from "../types";
import escapeRegExp from "./escapeRegExp";

export default class JestToTestAdapterMapper {
  constructor(
    private readonly workDir: string,
  ) {
  }

  public mapJestAssertionToTestDecorations(
    result: JestAssertionResults,
    file: string,
    reconciler?: TestReconciler,
  ): TestDecoration[] {
    const assertionResult = this.getAssertionStatus(result, file, reconciler);
    if (assertionResult) {
      return [
        {
          line: assertionResult.line || 0,
          message: assertionResult.terseMessage || "",
        },
      ];
    }
    return [];
  }

  public mapJestResponseToTestSuiteInfo({ results }: IJestResponse): TestSuiteInfo {
    const suiteResults = results.testResults.map((t) => this.mapJestFileResultToTestSuiteInfo(t));

    return {
      children: this.merge([], suiteResults),
      id: "root",
      label: "Jest",
      type: "suite",
    };
  }

  public mapJestParseToTestSuiteInfo(loadedTests: IParseResults[]): TestSuiteInfo {
    const testSuiteInfos = loadedTests
      .map((testFile) => {
        let fileName = null;
        const testCases = testFile.itBlocks.map((itBlock) => {
          fileName = itBlock.file;

          const testName = itBlock.name ? itBlock.name : "test has no name";

          return {
            file: fileName,
            id: this.getTestId(fileName, testName),
            label: testName,
            line: itBlock.start.line,
            skipped: false,
            type: "test",
          } as TestInfo;
        });

        return fileName
          ? this.transformFileResultIntoTree(fileName, testCases)
          : null;
      })
      .filter((testSuiteInfo) => testSuiteInfo) as TestSuiteInfo[];

    return {
      children: this.merge([], testSuiteInfos),
      id: "root",
      label: "Jest",
      type: "suite",
    };
  }

  public mapTestIdsToTestFilter(tests: string[]): ITestFilter | null {
    if (tests[0] && tests[0] === "root") {
      return null;
    }

    // Test matching is done by creating a regular expression out of the specified test IDs
    if (tests[0].includes(TEST_ID_SEPARATOR)) {
      // Test filter is a name
      return {
        testFileNamePattern: `(${tests
          .map((t) => t.split(TEST_ID_SEPARATOR)[0])
          .join("|")})`,
        testNamePattern: `(${tests
          .map((t) => t.split(TEST_ID_SEPARATOR)[1])
          .join("|")})`,
      };
    } else {
      // Test filter is a file path
      return {
        testFileNamePattern: `(${tests.join("|")})`,
      };
    }
  }

  public mapJestFileResultToTestSuiteInfo(result: JestFileResults): TestSuiteInfo {
    const testSuites = result.assertionResults
      .filter(
        (testResult) =>
          testResult.ancestorTitles && testResult.ancestorTitles.length > 0,
      )
      .reduce((testTree, testResult) => {
        const target = (testResult.ancestorTitles as string[]).reduce(
          (innerTree, ancestorTitle, i, a) => {
            const fullName = a.slice(0, i + 1).join(" ");
            const id = this.getTestId(result.name, fullName);
            let next = innerTree.find((x) => x.id === id);
            if (next) {
              return (next as TestSuiteInfo).children;
            } else {
              next = {
                children: [],
                file: result.name,
                id,
                label: ancestorTitle,
                type: "suite",
              };
              innerTree.push(next);
              return next.children;
            }
          },
          testTree,
        );

        target.push(this.mapJestAssertionToTestInfo(testResult, result));

        return testTree;
      }, new Array<TestSuiteInfo | TestInfo>());

    const testCases: Array<
      TestSuiteInfo | TestInfo
    > = result.assertionResults
      .filter(
        (testResult) =>
          !testResult.ancestorTitles || testResult.ancestorTitles.length === 0,
      )
      .map((testResult) => this.mapJestAssertionToTestInfo(testResult, result));

    return this.transformFileResultIntoTree(result.name, testCases.concat(testSuites));
  }

  public mapJestAssertionToTestInfo(
    assertionResult: JestAssertionResults,
    fileResult: JestFileResults,
    reconciler?: TestReconciler,
  ): TestInfo {
    const assertionStatus = this.getAssertionStatus(
      assertionResult,
      fileResult.name,
      reconciler,
    );
    let line: number | undefined;
    let skipped: boolean = false;
    if (assertionStatus) {
      line = assertionStatus.line;
      skipped = assertionStatus.status === "KnownSkip";
    }

    return {
      file: fileResult.name,
      id: this.getTestId(fileResult.name, assertionResult.fullName),
      label: assertionResult.title,
      line,
      skipped,
      type: "test",
    };
  }

  private getAssertionStatus(
    result: JestAssertionResults,
    file: string,
    reconciler?: TestReconciler,
  ): TestAssertionStatus | undefined {
    if (reconciler) {
      const fileResult = reconciler.assertionsForTestFile(file) || [];
      return fileResult.find((x) => x.title === result.fullName);
    }
    return undefined;
  }

  private merge(
    mergeDestination: Array<TestSuiteInfo | TestInfo>,
    mergeSource: Array<TestSuiteInfo | TestInfo>,
  ): Array<TestSuiteInfo | TestInfo> {
    mergeSource.forEach((suiteResult) => {
      const existingResult = mergeDestination.find(
        (result) => result.id === suiteResult.id,
      );
      if (
        existingResult &&
        (existingResult as TestSuiteInfo).children &&
        (suiteResult as TestSuiteInfo).children
      ) {
        this.merge(
          (existingResult as TestSuiteInfo).children,
          (suiteResult as TestSuiteInfo).children,
        );
      } else {
        mergeDestination.push(suiteResult);
      }
    });

    return mergeDestination;
  }

  private transformFileResultIntoTree(
    resultFileName: string,
    fileTestCases: Array<TestSuiteInfo | TestInfo>,
  ): TestSuiteInfo {
    const pathWithoutWorkDir = resultFileName
      .replace(new RegExp(escapeRegExp(this.workDir), "ig"), "")
      .replace(/\\/g, "/");
    const path = pathWithoutWorkDir.split("/");
    const lastPathElement = path[path.length - 1];
    const lastChild: TestSuiteInfo = {
      children: fileTestCases,
      file: resultFileName,
      id: pathWithoutWorkDir,
      label: lastPathElement,
      type: "suite",
    };
    return this.createDirectoryStructure(lastChild, path, path.length - 2);
  }

  private createDirectoryStructure(
    currentLevel: TestSuiteInfo,
    thePath: string[],
    currentPathIndex: number,
  ): TestSuiteInfo {
    let currentPathElement = thePath[currentPathIndex];
    if (currentPathElement === "") {
      currentPathIndex--;
      currentPathElement = thePath[currentPathIndex];
    }
    if (currentPathElement === undefined) { return currentLevel; }

    const currentPathId = thePath.slice(0, currentPathIndex + 1).join("/");
    const nextLevel: TestSuiteInfo = {
      children: [currentLevel],
      id: currentPathId,
      label: currentPathElement,
      type: "suite",
    };

    return this.createDirectoryStructure(nextLevel, thePath, currentPathIndex - 1);
  }

  private getTestId(fileName: string, testName: string): string {
    const pathWithoutWorkDir = fileName
      .replace(new RegExp(escapeRegExp(this.workDir), "ig"), "")
      .replace(/\\/g, "/");

    return `${pathWithoutWorkDir}${TEST_ID_SEPARATOR}^${escapeRegExp(testName)}$`;
  }
}
