// Export approved offering submissions (poster submissions) from Airtable
// into a CSV, and import that CSV into Felt.
//
// Written with help from Cursor.

// Load environment variables
import dotenv from 'dotenv';
dotenv.config();

// Import necessary modules
import Airtable from 'airtable';
import { stringify } from 'csv-stringify/sync'; // Synchronous version for simplicity
import express from 'express';
import ngrok from 'ngrok';
import fs from 'fs';

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
const NGROK_TIMEOUT = 5000; // milliseconds

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

  // Use synchronous stringify for simplicity
  const csvOutput = stringify([desiredFields, ...data], { header: false });
  return csvOutput;
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

  // Connect to Ngrok with explicit configuration
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

  if (!response.ok) {
    throw new Error(`Failed to fetch layers: ${response.statusText}`);
  }

  const layers = await response.json();
  return layers.some(layer => layer.name === layerName);
}

// Create or refresh a layer in Felt map
async function createOrRefreshFeltLayer(feltMapId, csvUrl, layerName) {
  const layerExists = await checkLayerExists(feltMapId, layerName);

  if (layerExists) {
    // Refresh the existing layer
    const layersResponse = await fetch(`https://felt.com/api/v2/maps/${feltMapId}/layers`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${FELT_API_KEY}`,
        'Content-Type': 'application/json',
      },
    });

    if (!layersResponse.ok) {
      throw new Error(`Failed to fetch layers for refreshing: ${layersResponse.statusText}`);
    }

    const layersData = await layersResponse.json();
    const existingLayer = layersData.find(layer => layer.name === layerName);

    if (existingLayer) {
      const refreshResponse = await fetch(`https://felt.com/api/v2/maps/${feltMapId}/layers/${existingLayer.id}/refresh`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${FELT_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          import_url: csvUrl,
        }),
      });

      if (!refreshResponse.ok) {
        throw new Error(`Failed to refresh layer: ${refreshResponse.statusText}`);
      }

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

    if (!uploadResponse.ok) {
      throw new Error(`Failed to create new layer: ${uploadResponse.statusText}`);
    }

    const uploadData = await uploadResponse.json();
    console.log('New layer created successfully in Felt map');
    return uploadData;
  }
}

// Main logic with top-level await
let server;
let ngrokUrl;
try {
  // Fetch records from Airtable
  console.log('Fetching records from Airtable...');
  const records = await fetchAirtableRecords();

  if (records.length === 0) {
    console.log('No approved records found. Exiting.');
    process.exit(0);
  }

  // Prepare CSV data
  console.log('Preparing CSV data...');
  const csvData = prepareCsvData(records);
  fs.writeFileSync('offerings.csv', csvData); // Optional: Save CSV locally

  // Host CSV and get public URL
  console.log('Hosting CSV data...');
  const { url, server: expressServer } = await hostCsvWithNgrok(csvData);
  server = expressServer;
  ngrokUrl = url;

  // Create or refresh the Felt layer
  console.log('Updating Felt layer...');
  await createOrRefreshFeltLayer(FELT_MAP_ID, url, FELT_LAYER_NAME);

  // Wait to ensure the request is processed
  console.log(`Waiting for ${NGROK_TIMEOUT / 1000} seconds...`);
  await new Promise(resolve => setTimeout(resolve, NGROK_TIMEOUT));

  console.log('Process completed successfully.');
} catch (error) {
  console.error('Error:', error);
} finally {
  // Clean up
  console.log('Cleaning up...');
  try {
    if (ngrokUrl) {
      await ngrok.disconnect();
      await ngrok.kill();
      console.log('Ngrok disconnected and killed.');
    }
  } catch (ngrokError) {
    console.error('Error disconnecting ngrok:', ngrokError);
  }

  try {
    if (server) {
      server.close(() => {
        console.log('Express server closed.');
      });

      // Wait briefly to ensure the server has closed
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  } catch (serverError) {
    console.error('Error closing server:', serverError);
  }

  console.log('Cleanup complete. Exiting now.');
  process.exit(0);
}
