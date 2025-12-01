// This line must be at the VERY TOP of your file
require('dotenv').config();

const express = require("express");
// const fs = require("fs");
const path = require("path");
const cors = require("cors");
const xml2js = require("xml2js"); // Library to convert XML to JSON

const app = express();
const PORT = process.env.PORT || 5000;

// Get the folder path from your .env file
const xmlFolderPath = process.env.XML_FOLDER_PATH;

// Middleware to allow the React frontend to access the server
app.use(cors());

function get_time_date(timestamp) {
  if (!timestamp || typeof timestamp !== "string") return [];

  let parts = timestamp.split("T");
  if (parts.length !== 2) return [];

  let [date, time] = parts;
  return [date, time.replace("Z", "")]; // remove trailing 'Z' if present (from ISO format)
}

function extractBaseName(name) {
  return name.replace(/\s*\(\d+\)\s*$/, "").trim();
}


function naturalNameOrderDesc(a, b) {
  var numA = a.match(/\((\d+)\)/);
  var numB = b.match(/\((\d+)\)/);
  if (!numA && !numB) return b.localeCompare(a);
  if (!numA) return 1;
  if (!numB) return -1;
  return Number(numB[1]) - Number(numA[1]);
}

function getLatestFilesByGroup(files) {
  var groups = {};
  for (var i = 0; i < files.length; i++) {
    var f = files[i];
    var base = extractBaseName(f.filename);
    if (!groups[base]) groups[base] = [];
    groups[base].push(f);
  }

  var results = [];
  for (var base in groups) {
    var sorted = groups[base].sort(function (a, b) {
      console.log(a, b)
      var [dateA, timeA] = get_time_date(a.TimeStamp);
      var [dateB, timeB] = get_time_date(b.TimeStamp);
      console.log(dateA, dateB)
      console.log(JSON.stringify(timeA))

      if (dateA > dateB) return -1;
      if (dateA < dateB) return 1;
      if (timeA > timeB) return -1;
      if (timeA < timeB) return 1;

      return naturalNameOrderDesc(a.filename, b.filename);
    });


    results.push(sorted[0]);
  }

  return results;
}

// --- API Endpoints ---

// 1. API endpoint to get a list of available XML files
// app.get("/api/xmlfiles", (req, res) => {
//   // Check if the folder path is configured in the .env file
//   if (!xmlFolderPath) {
//     return res.status(500).send("Server is not configured with XML_FOLDER_PATH.");
//   }
//   console.log("Reading XML files from:", xmlFolderPath);

//   fs.readdir(xmlFolderPath, (err, files) => {
//     if (err) {
//       console.error("Error reading directory:", err);
//       return res.status(500).send("Could not list files in the directory.");
//     }
//     // Filter the list to only include files ending with .xml
//     const xmlFiles = files.filter(file => path.extname(file).toLowerCase() === '.xml');
//     res.json(xmlFiles);
//   });
// });

// At the top of your file, get the promise-based version of fs
const fs = require("fs").promises;
const { parseStringPromise } = require("xml2js");

// ... your other setup code (express, cors, etc.)

function baseFileKey(originalFilename) {
  // Remove extension, then trailing " (digits)" if present
  return originalFilename
    .replace(/\.xml$/i, "")
    .replace(/\s*\(\d+\)$/,'')
    .trim();
}

app.get("/api/xmlfiles", async (req, res) => {
  if (!xmlFolderPath) return res.status(500).send("Server is not configured with XML_FOLDER_PATH.");

  try {
    console.log("Reading XML files from:", xmlFolderPath);
    const files = await fs.readdir(xmlFolderPath);
    const xmlFiles = files.filter(f => path.extname(f).toLowerCase() === ".xml");
    console.log("Found XML files:", xmlFiles);

    const fileResults = await Promise.all(
      xmlFiles.map(async (filename) => {
        try {
          const fullPath = path.join(xmlFolderPath, filename);
          const stats = await fs.stat(fullPath);
          let xmlData = await fs.readFile(fullPath, "utf-8");
          xmlData = xmlData.replace(/&(?!amp;|lt;|gt;|quot;|apos;)/g, "&amp;");

          const parsed = await parseStringPromise(xmlData, { explicitArray: false });
          const isHSP = filename.startsWith("HSP"); // fix: consistent name

            const licensedUsersRaw = parsed?.Document?.System?.KeyDetails?.Lijn5 || "";
          const licensedUsers = licensedUsersRaw.split("=")[1]?.trim() || "";

          const commonData = {
            filename: filename.replace(/\.xml$/i, ""),
            isHSP,
            TimeStamp: stats.mtime.toISOString(),
            PatchedDate: parsed?.Document?.Eva?.PILOOT || "",
            IPAddress: parsed?.Document?.System?.Server?.IPAddress || "",
            Version: parsed?.Document?.Eva?.VER || "",
            LicensedUsers: licensedUsers
          };

          let rows = [];
          if (isHSP) {
            const nameSpaces = parsed?.Document?.System?.NameSpaces;
            if (nameSpaces && typeof nameSpaces === "object") {
              for (const [nsName, nsData] of Object.entries(nameSpaces)) {
                // Skip ADP namespace for HSP files
                if (nsName === "ADP") continue;
                rows.push({
                  ...commonData,
                  namespace: nsName,
                  Users: nsData?.Users || ""
                });
              }
            }
          } else {
            rows.push({
              ...commonData,
              namespace: parsed?.Document?.System?.Firma || "",
              Users: parsed?.Document?.System?.Users || ""
            });
          }

          return {
            originalFilename: filename,
            key: baseFileKey(filename),
            mtime: stats.mtime.getTime(),
            rows
          };
        } catch (e) {
          console.error("Error processing file", filename, e);
          return {
            originalFilename: filename,
            key: baseFileKey(filename),
            mtime: 0,
            rows: []
          };
        }
      })
    );

    // Group by base key, keep record with highest mtime
    const latestMap = {};
    for (const rec of fileResults) {
      if (!latestMap[rec.key] || rec.mtime > latestMap[rec.key].mtime) {
        latestMap[rec.key] = rec;
      }
    }

    // Collect rows from chosen (latest) physical files
    const latestRows = Object.values(latestMap).flatMap(r => r.rows);

    console.log("Total rows (latest per base):", latestRows.length);
    res.json(latestRows);

  } catch (err) {
    console.error("Error processing XML files:", err);
    res.status(500).send("An error occurred while processing the XML files.");
  }
});

// 2. API endpoint to get the content of a specific XML file
app.get("/api/xmlfiles/:filename", (req, res) => {
  const { filename } = req.params;
  //console.log("Requested file:", filename);

  // Security Check: Prevent users from accessing other directories or non-XML files
  if (filename.includes('..') || !filename.toLowerCase().endsWith('.xml')) {
    return res.status(400).send("Invalid filename.");
  }

  const fullPath = path.join(xmlFolderPath, filename);
  //console.log("Full file path:", fullPath);

  fs.readFile(fullPath, "utf-8", (err, xmlData) => {
    if (err) {
      console.error(`Error reading file ${fullPath}:`, err);
      return res.status(404).send("File not found or could not be read.");
    }
    // Convert XML to JSON
    xml2js.parseString(xmlData, { explicitArray: false }, (err, result) => {
      if (err) {
        console.error("Error parsing XML:", err);
        return res.status(500).send("Error parsing XML");
      }
      res.json(result);
    });
  });
});



// --- Start the Server ---

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  // Log the folder path to confirm it's loaded correctly on startup
  if (xmlFolderPath) {
    console.log(`Watching for XML files in: ${xmlFolderPath}`);
  } else {
    console.error("ERROR: XML_FOLDER_PATH is not set in your .env file!");
  }
});