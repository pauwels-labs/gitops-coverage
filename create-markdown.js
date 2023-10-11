// Import modules required for reading files line-by-line
const fs = require("fs");
const readline = require("readline");

// Paths to the files we'll need to compute coverage summary
let jsonSummaryFilePath = process.env["GITOPS_COVERAGE_JSON_SUMMARY_FILE_PATH"];
if (!jsonSummaryFilePath) {
  jsonSummaryFilePath = "./coverage/coverage-summary.json";
}

let lcovInfoFilePath = process.env["GITOPS_COVERAGE_LCOV_INFO_FILE_PATH"];
if (!lcovInfoFilePath) {
  lcovInfoFilePath = "./coverage/lcov.info";
}

let projectPath = process.env["GITOPS_COVERAGE_PROJECT_PATH"];
if (!projectPath) {
  projectPath = __dirname;
}
projectPath.replace(/\/+$/, "");

let outputFile = process.env["GITOPS_COVERAGE_OUTPUT_FILE"];

// Load the json summary into native JSON
let jsonSummary = {};
try {
  jsonSummary = Object.fromEntries(
    Object.entries(require(jsonSummaryFilePath)).map(([k, v]) => [k.replace(projectPath + "/", ""), v])
  );
} catch (error) {
  console.log("Could not load a JSON summary file, skipping and creating from scratch");
}

try {
  // Abandon if the lcov info file doesn't exist
  if (!fs.existsSync(lcovInfoFilePath)) {
    throw new Error(`${lcovInfoFilePath} file not found`);
  }

  // Open a line-by-line read of the lcov file
  const fileStream = fs.createReadStream(lcovInfoFilePath);
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity
  });

  // These globals are used to record the file currently being read in the lcov file,
  // as well as the beginning and the end of the uncovered lines mentioned
  let filename = null;
  let isRecordingUncovered = false;
  let uncoveredBeginning = 0;
  let uncoveredEnd = 0;

  // For each line in the file, check if it's either:
  // - A line identifying the file being analyzed (prefix: SF)
  // - A line identifying a line of code and whether or not it was covered (prefix: DA)
  rl.on("line", (line) => {
    // Regexes for the identifying the type of line
    const reSF = /^SF:(.+)$/m;
    const reDA = /^DA:([0-9]+),0$/m;
    const filenameMatches = line.match(reSF);
    const uncoveredMatches = line.match(reDA);

    // If this is a filename line, record the name of the file being analyzed
    if (filenameMatches && filenameMatches.length == 2) {
      filename = filenameMatches[1];
    }
    // If this is a line identifying that a line of code is uncovered and we are
    // not currently recording a range of uncovered lines, begin the range recording
    else if (uncoveredMatches && uncoveredMatches.length == 2 && !isRecordingUncovered) {
      isRecordingUncovered = true;
      uncoveredBeginning = +uncoveredMatches[1];
      uncoveredEnd = +uncoveredMatches[1];
    }
    // If this is a line identifying that a line of code is uncovered and we are
    // currently recording a range of uncovered lines, update the end-point of that range
    else if (uncoveredMatches && uncoveredMatches.length == 2 && isRecordingUncovered) {
      uncoveredEnd = +uncoveredMatches[1];
    }
    // If this is a line identifying that a line of code is covered and we are currently
    // recording a range of uncovered lines, record the end of that range
    else if (!uncoveredMatches && isRecordingUncovered) {
      let uncoveredString = `${uncoveredBeginning}`;
      if (uncoveredEnd != uncoveredBeginning) {
        uncoveredString += `-${uncoveredEnd}`;
      }
      if (!jsonSummary[filename]) {
        jsonSummary[filename] = {}
      }
      if (!jsonSummary[filename].uncovered) {
        jsonSummary[filename].uncovered = [];
      }
      jsonSummary[filename].uncovered.push(uncoveredString);
      isRecordingUncovered = false;
    }
  });

  // Build the markdown comment that will contain the code coverage results after
  // the lcov file reading and analysis has completed
  rl.on("close", () => {
    // This reorganizes the results from a flat listing of files into a hierarchial listing.
    // Individual files in the root remain at the top-level, each directory and sub-directory
    // is all at the top level, with the individual files in those directories listed within
    // them. This keep a maximum depth of two.
    let dividedJsonSummary = {};
    for (const filePath in jsonSummary) {
      if (filePath == "total") {
        dividedJsonSummary[filePath] = jsonSummary[filePath];
      } else {
        const pathSlices = filePath.split("/");
        const pathWithoutFile = pathSlices.slice(0, -1).join("/");

        if (!dividedJsonSummary[pathWithoutFile]) {
          dividedJsonSummary[pathWithoutFile] = {};
        }
        dividedJsonSummary[pathWithoutFile][pathSlices[pathSlices.length - 1]] = jsonSummary[filePath];
      }
    }

    // Divide the summary into the total summary and the individual file/folder summaries
    const { total: totalSummary, ...filesSummary } = dividedJsonSummary;

    // Build the Markdown table containing all summarizing information
    const table = buildTable(totalSummary, filesSummary);

    // Build the complete Markdown comment with the table inside
    const mdComment = `Testing has completed, a summary of the code coverage results is provided below.

<details>

<summary>Code coverage summary</summary>

${table}
</details>
`;
    if (outputFile) {
      fs.writeFile(outputFile, mdComment, err => {
        if (err) {
          throw err
        } else {
          console.log(`Successfully wrote gitops coverage markdown to ${outputFile}`);
        }
      });
    } else {
      console.log(mdComment);
    }
  });

  rl.on("error", (err) => {
    console.error(`Error reading the file: ${err.message}`);
  });
} catch (err) {
  console.error(`Error: ${err.message}`);
}

// The colors used to highlight green, orange, and red badges in the markdown
const GREEN = "147317";
const ORANGE = "c27d15";
const RED = "c23815";

// Takes a summary stats object (composed typically of "statements", "branches", "functions",
// and "lines" keys) and computes the color each of those categories should have based on
// the percent coverage. It then adds the selected color as another key in the summary.
function addColorToStats(stats) {
  const statsToProcess = ["statements", "branches", "functions", "lines"];

  for (const stat of statsToProcess) {
    if (stats[stat].pct >= 80) {
      stats[stat].color = GREEN;
    }
    else if (stats[stat].pct >= 50) {
      stats[stat].color = ORANGE;
    } else {
      stats[stat].color = RED;
    }
  }

  return stats;
}

// Alias for buildTableDepth that starts the recursive table building at a depth of 0
function buildTable(total, files) {
  return buildTableDepth(total, files, 0)
}

// Recursively builds the markdown table containing all code coverage statistics
function buildTableDepth(total, files, depth) {
  // If depth hasn't been defined or is set to 0, set it to 1 to indicate the start
  if (typeof depth != "number" || depth <= 0) {
    depth = 1;
  }

  // Define our table string
  let table = "";

  // If a total summary object has been provided, add the table header and total summary line
  // at the top of the table
  if (total) {
    const totalColored = addColorToStats(total);
    table += `File|% Stmts|% Branch|% Funcs|% Lines|Uncovered Line #s
----|-------|--------|-------|-------|-----------------
![All files](https://img.shields.io/badge/All%20files-${totalColored.statements.color}?style=for-the-badge)|![${totalColored.statements.pct}](https://img.shields.io/badge/${totalColored.statements.pct}-${totalColored.statements.color}?style=for-the-badge)|![${totalColored.branches.pct}](https://img.shields.io/badge/${totalColored.branches.pct}-${totalColored.branches.color}?style=for-the-badge)|![${totalColored.functions.pct}](https://img.shields.io/badge/${totalColored.functions.pct}-${totalColored.functions.color}?style=for-the-badge)|![${totalColored.lines.pct}](https://img.shields.io/badge/${totalColored.lines.pct}-${totalColored.lines.color}?style=for-the-badge)|
`;
  }

  // Iterate through each entry in the files/folders, generating a row in the table for each
  for (const fileKey in files) {
    // Checks to see if the key is a js file or a directory
    const isJsFileRe = /^.+\.js$/m;

    // If this is a js file, write a row that contains all summary statistics for the coverage
    // of the individual file including individual uncovered lines
    if (fileKey.match(isJsFileRe)) {
      // Fetches the summary statistics from the object
      const fileEntry = files[fileKey];

      // Computes the badge color for each column of the row based on the percent coverage
      const fileEntryColored = addColorToStats(fileEntry);

      // Adds space indentation to the filename in the first column based on the depth
      // of the recursion
      const indent = '&nbsp;'.repeat(depth * 2);

      // Generates individual red-colored badges for each range of uncovered lines
      let uncoveredLines = "";
      if (Array.isArray(fileEntry.uncovered) && fileEntry.uncovered.length > 0) {
        for (const line of fileEntry.uncovered) {
          const lineCharReplaced = line.replace("-", "--");
          uncoveredLines += `![${line}](https://img.shields.io/badge/${lineCharReplaced}-${RED}?style=for-the-badge)&nbsp;`
        }
      }

      // Replaces special characters in the file name for adding to the badge URL
      const fileKeyCharsReplaced = fileKey.replace(" ", "_").replace("-", "--");

      // Generates the row for the file
      table += `${indent}![${fileKey}](https://img.shields.io/badge/${fileKeyCharsReplaced}-${fileEntryColored.statements.color}?style=for-the-badge)|![${fileEntryColored.statements.pct}](https://img.shields.io/badge/${fileEntryColored.statements.pct}-${fileEntryColored.statements.color}?style=for-the-badge)|![${fileEntryColored.branches.pct}](https://img.shields.io/badge/${fileEntryColored.branches.pct}-${fileEntryColored.branches.color}?style=for-the-badge)|![${fileEntryColored.functions.pct}](https://img.shields.io/badge/${fileEntryColored.functions.pct}-${fileEntryColored.functions.color}?style=for-the-badge)|![${fileEntryColored.lines.pct}](https://img.shields.io/badge/${fileEntryColored.lines.pct}-${fileEntryColored.lines.color}?style=for-the-badge)|${uncoveredLines}
`;
    } else {
      // Fetches all the files in the directory
      const fileEntry = files[fileKey];

      // Computes the sum of all code coverage statistics for all files in the directory
      const sums = sumCoverage(fileEntry, false);

      // Computes the badge color for each column of the row based on the percent coverage
      // of all files in the directory
      const sumsColored = addColorToStats(sums);

      // Adds space indentation to the directory name in the first column based on the depth
      // of the recursion
      const indent = '&nbsp;'.repeat(depth * 2);

      // Replaces special characters in the directory name for adding to the badge URL
      const fileKeyCharsReplaced = fileKey.replace(" ", "_").replace("-", "--");

      // Generates the row for the directory
      table += `${indent}![${fileKey}](https://img.shields.io/badge/${fileKeyCharsReplaced}-${sumsColored.statements.color}?style=for-the-badge)|![${sumsColored.statements.pct}](https://img.shields.io/badge/${sumsColored.statements.pct}-${sumsColored.statements.color}?style=for-the-badge)|![${sumsColored.branches.pct}](https://img.shields.io/badge/${sumsColored.branches.pct}-${sumsColored.branches.color}?style=for-the-badge)|![${sumsColored.functions.pct}](https://img.shields.io/badge/${sumsColored.functions.pct}-${sumsColored.functions.color}?style=for-the-badge)|![${sumsColored.lines.pct}](https://img.shields.io/badge/${sumsColored.lines.pct}-${sumsColored.lines.color}?style=for-the-badge)|
`;

      // Recursively adds rows for each file in the directory
      table += buildTableDepth(null, fileEntry, depth + 1);
    }
  }

  return table;
}

// Computes the sum of all coverage statistics for all files in the object
// of tested files
function sumCoverage(obj, recurse) {
  let summary = {
    lines: {
      total: 0,
      covered: 0,
      skipped: 0,
      pct: 0
    },
    functions: {
      total: 0,
      covered: 0,
      skipped: 0,
      pct: 0
    },
    statements: {
      total: 0,
      covered: 0,
      skipped: 0,
      pct: 0
    },
    branches: {
      total: 0,
      covered: 0,
      skipped: 0,
      pct: 0
    }
  };
  for (const entryKey in obj) {
    const isJsFileRe = /^.+\.js$/m;
    if (entryKey.match(isJsFileRe)) {
      let entry = obj[entryKey];
      if (entry.lines) {
        if (typeof entry.lines.total == "number") {
          summary.lines.total += entry.lines.total;
        }
        if (typeof entry.lines.covered == "number") {
          summary.lines.covered += entry.lines.covered;
        }
        if (typeof entry.lines.skipped == "number") {
          summary.lines.skipped += entry.lines.skipped;
        }
      }
      if (entry.functions) {
        if (typeof entry.functions.total == "number") {
          summary.functions.total += entry.functions.total;
        }
        if (typeof entry.functions.covered == "number") {
          summary.functions.covered += entry.functions.covered;
        }
        if (typeof entry.functions.skipped == "number") {
          summary.functions.skipped += entry.functions.skipped;
        }
      }
      if (entry.statements) {
        if (typeof entry.statements.total == "number") {
          summary.statements.total += entry.statements.total;
        }
        if (typeof entry.statements.covered == "number") {
          summary.statements.covered += entry.statements.covered;
        }
        if (typeof entry.statements.skipped == "number") {
          summary.statements.skipped += entry.statements.skipped;
        }
      }
      if (entry.branches) {
        if (typeof entry.branches.total == "number") {
          summary.branches.total += entry.branches.total;
        }
        if (typeof entry.branches.covered == "number") {
          summary.branches.covered += entry.branches.covered;
        }
        if (typeof entry.branches.skipped == "number") {
          summary.branches.skipped += entry.branches.skipped;
        }
      }
    }
    else if (!entryKey.match(isJsFileRe) && entryKey != "total" && recurse) {
      const recursedSummary = sumCoverage(obj[entryKey], recurse);
      summary.lines.total += recursedSummary.lines.total;
      summary.lines.covered += recursedSummary.lines.covered;
      summary.lines.skipped += recursedSummary.lines.skipped;
      summary.functions.total += recursedSummary.functions.total;
      summary.functions.covered += recursedSummary.functions.covered;
      summary.functions.skipped += recursedSummary.functions.skipped;
      summary.statements.total += recursedSummary.statements.total;
      summary.statements.covered += recursedSummary.statements.covered;
      summary.statements.skipped += recursedSummary.statements.skipped
      summary.branches.total += recursedSummary.branches.total;
      summary.branches.covered += recursedSummary.branches.covered;
      summary.branches.skipped += recursedSummary.branches.skipped;
    }
  }
  summary.lines.pct = summary.lines.total == 0 ? 0 : Math.round(((summary.lines.covered / summary.lines.total) + Number.EPSILON) * 10000) / 100;
  summary.functions.pct = summary.functions.total == 0 ? 0 : Math.round(((summary.functions.covered / summary.functions.total) + Number.EPSILON) * 10000) / 100;
  summary.statements.pct = summary.statements.total == 0 ? 0 : Math.round(((summary.statements.covered / summary.statements.total) + Number.EPSILON) * 10000) / 100;
  summary.branches.pct = summary.branches.total == 0 ? 0 : Math.round(((summary.branches.covered / summary.branches.total) + Number.EPSILON) * 10000) / 100;
  return summary;
}
