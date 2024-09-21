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
const desiredFields = ['Latitude', 'Longitude', 'Picture', 'Submitted At'];

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

// Import required modules
const fetch = require('node-fetch');
const FormData = require('form-data');

// Read environment variables
const feltApiKey = process.env.FELT_API_KEY;
const feltMapId = process.env.FELT_MAP_ID;

// Function to create a new layer in Felt map
async function createFeltLayer(csvData) {
  const uploadResponse = await fetch(`https://felt.com/api/v2/maps/${feltMapId}/upload`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${feltApiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      name: 'Poster Submissions'
    })
  });

  const uploadData = await uploadResponse.json();

  if (uploadData.url) {
    console.log('Felt S3 upload URL:', uploadData.url);  // Print the S3 URL

    const form = new FormData();
    Object.entries(uploadData.presigned_attributes).forEach(([key, value]) => {
      form.append(key, value);
    });
    form.append('file', Buffer.from(csvData), {
      filename: 'offerings.csv',
      contentType: 'text/csv'
    });

    await fetch(uploadData.url, {
      method: 'POST',
      body: form
    });

    console.log('Layer created successfully in Felt map');
  } else {
    console.error('Failed to get upload URL from Felt');
  }
}

// Call the function to create the layer
createFeltLayer(csvData);
