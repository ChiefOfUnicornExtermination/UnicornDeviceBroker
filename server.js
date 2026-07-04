const express = require('express');
const mqtt = require('mqtt');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(cors());

