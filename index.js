// Export approved offering submissions (poster submissions) from the Airtable
// into a CSV, import that CSV into Felt.
//
// Written with help from Cursor.

const Airtable = require('airtable');
const fs = require('fs');
const path = require('path');
const csv = require('csv-stringify');
require('dotenv').config();

// Initialize Airtable
const base = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY }).base(process.env.AIRTABLE_BASE_ID);

// Define the table name
const table = base('poster submissions');

// Fetch records from Airtable
const records = await table.select({
  filterByFormula: "Status = 'Approved'"
}).all();

// Extract field names for CSV headers
const headers = Object.keys(records[0].fields);

// Define the specific fields we want
const desiredFields = ['Longitude', 'Latitude', 'Submitted At', 'Picture'];

// Prepare data for CSV
const data = records.map(record => 
  headers.map(header => {
    if (!desiredFields.includes(header)) {
      return null;  // This will be filtered out later
    }
    const field = record.fields[header];
    if (Array.isArray(field) && field.length > 0) {
      try {
        const firstFile = field[0]
        if (firstFile.thumbnails && firstFile.thumbnails.large && firstFile.thumbnails.large.url) {
          return firstFile.thumbnails.large.url;
        }
      } catch (error) {
        // If parsing fails, return the original field value
        return field[0];
      }
    }
    return field;
  }).filter(item => item !== null)  // Remove null values
);

// Convert records to CSV with headers
const csvStringify = csv.stringify;
const csvData = await new Promise((resolve, reject) => {
  csvStringify([desiredFields, ...data], (err, output) => {
    if (err) reject(err);
    else resolve(output);
  });
});

// Write CSV to file
fs.writeFileSync(path.join(__dirname, 'offerings.csv'), csvData);

console.log('CSV file with headers has been created.');
