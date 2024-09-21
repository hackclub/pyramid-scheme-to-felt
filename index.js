// Export approved offering submissions (poster submissions) from the Airtable
// into a CSV, import that CSV into Felt.
//
// Written with help from Cursor.

const Airtable = require('airtable');
const fs = require('fs');
const path = require('path');
const csv = require('csv-stringify');
require('dotenv').config();

const ngrok = require('ngrok');
const express = require('express');
const fetch = require('node-fetch');

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

// Function to create a temporary server and get a public URL
async function hostCSVWithNgrok(csvData) {
  const app = express();
  const port = 3000;

  app.get('/offerings.csv', (req, res) => {
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=offerings.csv');
    res.send(csvData);
  });

  const server = app.listen(port, () => {
    console.log(`Server running on http://localhost:${port}`);
  });

  // Connect to Ngrok with explicit configuration
  const url = await ngrok.connect({
    addr: port,
    authtoken: process.env.NGROK_AUTH_TOKEN,
    subdomain: process.env.NGROK_SUBDOMAIN,
    configPath: undefined,
  });
  console.log(`Ngrok tunnel created: ${url}`);

  return { url: `${url}/offerings.csv`, server };
}

// Function to check if a layer exists in Felt map
async function checkLayerExists(feltMapId, layerName) {
  const feltApiKey = process.env.FELT_API_KEY;

  const response = await fetch(`https://felt.com/api/v2/maps/${feltMapId}/layers`, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${feltApiKey}`,
      'Content-Type': 'application/json'
    }
  });

  const layers = await response.json();
  return layers.some(layer => layer.name === layerName);
}

// Function to create or refresh a layer in Felt map
async function createOrRefreshFeltLayer(csvUrl) {
  const feltApiKey = process.env.FELT_API_KEY;
  const feltMapId = process.env.FELT_MAP_ID;
  const layerName = 'Poster Submissions';

  const layerExists = await checkLayerExists(feltMapId, layerName);

  if (layerExists) {
    // Refresh the existing layer
    const layers = await fetch(`https://felt.com/api/v2/maps/${feltMapId}/layers`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${feltApiKey}`,
        'Content-Type': 'application/json'
      }
    }).then(res => res.json());

    const existingLayer = layers.find(layer => layer.name === layerName);
    
    if (existingLayer) {
      const refreshResponse = await fetch(`https://felt.com/api/v2/maps/${feltMapId}/layers/${existingLayer.id}/refresh`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${feltApiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          import_url: csvUrl
        })
      });

      const refreshData = await refreshResponse.json();
      console.log('Layer refreshed successfully in Felt map');
      return refreshData;
    }
  } else {
    // Create a new layer
    const uploadResponse = await fetch(`https://felt.com/api/v2/maps/${feltMapId}/upload`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${feltApiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        name: layerName,
        import_url: csvUrl
      })
    });

    const uploadData = await uploadResponse.json();
    console.log('New layer created successfully in Felt map');
    return uploadData;
  }
}

// Main function to orchestrate the process
async function main() {
  try {
    const { url, server } = await hostCSVWithNgrok(csvData);
    await createOrRefreshFeltLayer(url);

    await new Promise(resolve => setTimeout(resolve, 15 * 1000));
    console.log('Waited for 15 seconds');

    // Clean up
    await ngrok.disconnect();
    server.close();
  } catch (error) {
    console.error('Error:', error);
  }
}

// Run the main function
main();
