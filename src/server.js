import express from 'express';
import dotenv from 'dotenv';
import cors from 'cors';
import { initDatabase } from './core/database/setup.js';
import cookieParser from 'cookie-parser';
import v1Routes from './core/routes/v1.routes.js'; 
import { initCronJobs } from './core/cron/index.js'; 

dotenv.config();

const app = express();
app.use(express.json());
app.use(cors());
app.use(cookieParser());

// Import routes
app.use('/api/v1', v1Routes);

const PORT = process.env.PORT || 5000;

//
app.get('/', (req, res) => {
    res.send('Trusted Handyman API is running');
});

initDatabase().then(() => {
    initCronJobs();
    app.listen(PORT, () => {
        console.log(`Server running on port ${PORT}`);
    });
});