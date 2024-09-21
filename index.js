// Export approved offering submissions (poster submissions) from Airtable
// into a CSV, and import that CSV into Felt.

// Load environment variables
require('dotenv').config();

// Import necessary modules
const Airtable = require('airtable');
const csv = require('csv-stringify');
const express = require('express');
const fetch = require('node-fetch');
const ngrok = require('ngrok');

// Constants and configuration
const {
  AIRTABLE_API_KEY,
  AIRTABLE_BASE_ID,
  NGROK_AUTH_TOKEN,
  NGROK_SUBDOMAIN,
  FELT_API_KEY,
  FELT_MAP_ID,
} = process.env;

const AIRTABLE_TABLE_NAME = 'poster submissions';
const FELT_LAYER_NAME = 'Poster Submissions';
const PORT = 3000;
const NGROK_TIMEOUT = 15000; // milliseconds

// Initialize Airtable
const airtableBase = new Airtable({ apiKey: AIRTABLE_API_KEY }).base(AIRTABLE_BASE_ID);

// Fetch records from Airtable
async function fetchAirtableRecords() {
  try {
    const table = airtableBase(AIRTABLE_TABLE_NAME);
    const records = await table.select({
      filterByFormula: "Status = 'Approved'",
    }).all();
    return records;
  } catch (error) {
    console.error('Error fetching Airtable records:', error);
    throw error;
  }
}

// Prepare data for CSV
function prepareCsvData(records) {
  const desiredFields = ['Latitude', 'Longitude', 'Picture', 'Submitted At'];

  const data = records.map(record =>
    desiredFields.map(fieldName => {
      const field = record.fields[fieldName];
      if (fieldName === 'Picture' && Array.isArray(field) && field.length > 0) {
        const pictureField = field[0];
        return pictureField?.thumbnails?.large?.url || pictureField.url || null;
      }
      return field || null;
    })
  );

  return new Promise((resolve, reject) => {
    csv.stringify([desiredFields, ...data], (err, output) => {
      if (err) reject(err);
      else resolve(output);
    });
  });
}

// Host CSV data using Express and ngrok
async function hostCsvWithNgrok(csvData) {
  const app = express();

  app.get('/offerings.csv', (req, res) => {
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=offerings.csv');
    res.send(csvData);
  });

  const server = app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });

  const url = await ngrok.connect({
    addr: PORT,
    authtoken: NGROK_AUTH_TOKEN,
    subdomain: NGROK_SUBDOMAIN,
    configPath: undefined,
  });
  console.log(`Ngrok tunnel created: ${url}`);

  return { url: `${url}/offerings.csv`, server };
}

// Check if a layer exists in Felt map
async function checkLayerExists(feltMapId, layerName) {
  const response = await fetch(`https://felt.com/api/v2/maps/${feltMapId}/layers`, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${FELT_API_KEY}`,
      'Content-Type': 'application/json',
    },
  });

  const layers = await response.json();
  return layers.some(layer => layer.name === layerName);
}

// Create or refresh a layer in Felt map
async function createOrRefreshFeltLayer(feltMapId, csvUrl, layerName) {
  const layerExists = await checkLayerExists(feltMapId, layerName);

  if (layerExists) {
    // Refresh the existing layer
    const responseLayers = await fetch(`https://felt.com/api/v2/maps/${feltMapId}/layers`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${FELT_API_KEY}`,
        'Content-Type': 'application/json',
      },
    });
    const layersData = await responseLayers.json();
    const existingLayer = layersData.find(layer => layer.name === layerName);

    if (existingLayer) {
      const refreshResponse = await fetch(
        `https://felt.com/api/v2/maps/${feltMapId}/layers/${existingLayer.id}/refresh`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${FELT_API_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            import_url: csvUrl,
          }),
        }
      );

      const refreshData = await refreshResponse.json();
      console.log('Layer refreshed successfully in Felt map');
      return refreshData;
    }
  } else {
    // Create a new layer
    const uploadResponse = await fetch(`https://felt.com/api/v2/maps/${feltMapId}/upload`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${FELT_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: layerName,
        import_url: csvUrl,
      }),
    });

    const uploadData = await uploadResponse.json();
    console.log('New layer created successfully in Felt map');
    return uploadData;
  }
}

// Main function to orchestrate the process
async function main() {
  let server;
  try {
    // Fetch records from Airtable
    console.log('Fetching records from Airtable...');
    const records = await fetchAirtableRecords();

    // Prepare CSV data
    console.log('Preparing CSV data...');
    const csvData = await prepareCsvData(records);

    // Host CSV and get public URL
    console.log('Hosting CSV data...');
    const { url: csvUrl, server: csvServer } = await hostCsvWithNgrok(csvData);
    server = csvServer;

    // Create or refresh the Felt layer
    console.log('Updating Felt layer...');
    await createOrRefreshFeltLayer(FELT_MAP_ID, csvUrl, FELT_LAYER_NAME);

    // Wait to ensure the request is processed
    console.log(`Waiting for ${NGROK_TIMEOUT / 1000} seconds...`);
    await new Promise(resolve => setTimeout(resolve, NGROK_TIMEOUT));
  } catch (error) {
    console.error('Error:', error);
  } finally {
    // Clean up
    console.log('Cleaning up...');
    if (server) {
      server.close(() => {
        console.log('Express server closed');
      });
    }
    try {
      await ngrok.disconnect();
      console.log('Ngrok disconnected');
    } catch (error) {
      console.error('Error disconnecting ngrok:', error);
    }
    process.exit(0);
  }
}

// Run the main function
main().catch(error => {
  console.error('Unhandled error in main:', error);
  process.exit(1);
});
