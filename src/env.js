// Loads .env before anything reads process.env. Imported first by db.js, which
// every other module depends on, so the order is guaranteed.
// On Render the variables come from the dashboard and no .env file exists -
// dotenv simply does nothing in that case.
import { config } from 'dotenv';

config();
