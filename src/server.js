import express from 'express';
import dotenv from 'dotenv';
import cors from 'cors';
import { initDatabase } from './core/database/setup.js';
import cookieParser from 'cookie-parser';

dotenv.config();

const app = express();
app.use(express.json());
app.use(cors());
app.use(cookieParser());

// Import routes

const PORT = process.env.PORT || 5000;

app.get('/', (req, res) => {
    res.send('Trusted Handyman API is running');
});

initDatabase().then(() => {
    app.listen(PORT, () => {
        console.log(`Server running on port ${PORT}`);
    });
});