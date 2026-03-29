#!/usr/bin/env node

/**
 * 🌪️ NUCLEAR LIQUIDATION SNIPER V1 (SINGLE FILE STANDALONE)
 * 📊 Strategy: Mean Reversion of extreme Liquidation-driven 1m wicks
 * 💰 Capital: Scalable | Leverage: 1x (Raw)
 * 🛡️ Security: Delta-neutral pulse entries
 */

import WebSocket from 'ws';
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import cors from 'cors';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- CONFIGURATION ---
const CONFIG = {
    huntsFile: path.join(__dirname, 'server', 'data', 'active_pulses.json'),
    historyFile: path.join(__dirname, 'server', 'data', 'pulse_history.json'),
    
    // THRESHOLDS
    minClusterUSD: 1000000,   // $1M total liquidations in window
    clusterWindowMs: 15000,   // 15 seconds accumulation
    minDipPct: 0.6,           // Price must dip/spike by this %
    
    leverage: 1,              // Set to 1x as requested
    maxSlots: 10,             // Can handle 10 concurrent pulses
    profitTargetPct: 0.4,     // Pulse Profit (Unleveraged)
    stopLossPct: 0.2,         // Tight Scalp SL (Unleveraged)

    scanIntervalMs: 60 * 60 * 1000 // Refresh Top Symbols every hour
};

// --- STATE ---
let activeSlots = 0;
let topSymbols = [];
const clusters = new Map(); 

// --- UTILS ---
const log = (msg) => console.log(`[NUCLEAR] ${new Date().toLocaleTimeString()} | ${msg}`);

async function fetchTopSymbols(n = 100) {
    try {
        const res = await axios.get('https://fapi.binance.com/fapi/v1/ticker/24hr');
        topSymbols = res.data
            .filter(t => t.symbol.endsWith('USDT'))
            .sort((a,b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume))
            .slice(0, n)
            .map(t => t.symbol);
        log(`📡 Monitoring Top ${topSymbols.length} Binance Symbols.`);
    } catch (e) { log(`❌ Symbol Fetch Error: ${e.message}`); }
}

// --- ENGINE ---

function connect() {
    log('🔗 Connecting to Binance Liquidation Stream...');
    const ws = new WebSocket('wss://fstream.binance.com/ws/!forceOrder@arr');

    ws.on('message', (data) => {
        try {
            const raw = JSON.parse(data.toString());
            const order = raw.o; 
            const symbol = order.s;
            const side = order.S; 
            const price = parseFloat(order.p);
            const quantity = parseFloat(order.q);
            const valueUSD = price * quantity;

            // Only monitor our Top 100
            if (!topSymbols.includes(symbol)) return;

            processLiquidation(symbol, side, price, valueUSD);
        } catch (e) {}
    });

    ws.on('close', () => { setTimeout(connect, 5000); });
    ws.on('error', (e) => log(`❌ WS Error: ${e.message}`));
}

function processLiquidation(symbol, side, price, value) {
    const now = Date.now();
    let cluster = clusters.get(symbol);

    if (!cluster || (now - cluster.startTime > CONFIG.clusterWindowMs)) {
        clusters.set(symbol, { total: value, startTime: now, startPrice: price, side, count: 1 });
        return;
    }

    cluster.total += value;
    cluster.count++;

    if (cluster.total >= CONFIG.minClusterUSD && activeSlots < CONFIG.maxSlots) {
        const pMove = Math.abs((price - cluster.startPrice) / cluster.startPrice) * 100;
        if (pMove >= CONFIG.minDipPct) {
            const direction = cluster.side === 'SELL' ? 'LONG' : 'SHORT';
            executePulseEntry(symbol, direction, price, cluster.total);
            clusters.delete(symbol);
        }
    }
}

async function executePulseEntry(symbol, direction, price, intensity) {
    if (activeSlots >= CONFIG.maxSlots) return;
    activeSlots++;
    
    const pulse = {
        id: `pulse_${symbol}_${Date.now()}`,
        symbol, direction, entryPrice: price, entryTime: Date.now(),
        intensity, status: 'active', pnl: 0, capital: 100, leverage: CONFIG.leverage
    };

    log(`🚀 SNIPE: ${symbol} ${direction} | Intensity: $${(intensity/1e6).toFixed(1)}M | Price: ${price}`);
    
    savePulse(pulse);
    managePulse(pulse.id);
}

async function managePulse(id) {
    try {
        if (!fs.existsSync(CONFIG.huntsFile)) return;
        let active = JSON.parse(fs.readFileSync(CONFIG.huntsFile, 'utf8'));
        const pulse = active.find(p => p.id === id);
        if (!pulse || pulse.status !== 'active') return;

        const res = await axios.get(`https://fapi.binance.com/fapi/v1/ticker/price?symbol=${pulse.symbol}`);
        const current = parseFloat(res.data.price);
        
        pulse.pnl = pulse.direction === 'LONG' 
            ? ((current - pulse.entryPrice) / pulse.entryPrice) * 100
            : ((pulse.entryPrice - current) / pulse.entryPrice) * 100;

        // Update real-time file for the dashboard
        fs.writeFileSync(CONFIG.huntsFile, JSON.stringify(active, null, 2));

        // EXIT LOGIC
        if (pulse.pnl >= CONFIG.profitTargetPct || pulse.pnl <= -CONFIG.stopLossPct) {
            pulse.status = 'closed';
            pulse.exitPrice = current;
            pulse.finalPnL = pulse.pnl * CONFIG.leverage;
            saveHistory(pulse);
            
            const fresh = JSON.parse(fs.readFileSync(CONFIG.huntsFile, 'utf8')).filter(p => p.id !== id);
            fs.writeFileSync(CONFIG.huntsFile, JSON.stringify(fresh, null, 2));
            activeSlots--;
            log(`💸 EXIT: ${pulse.symbol} | PnL: ${pulse.finalPnL.toFixed(2)}% | Reversion: ✅`);
        } else {
            setTimeout(() => managePulse(id), 2000);
        }
    } catch (e) { setTimeout(() => managePulse(id), 2000); }
}

// --- SERVER (PORT 3009) ---

const app = express();
app.use(cors());
app.use(express.static(__dirname));

app.get('/api/pulse/active', (req, res) => {
    try {
        const data = fs.existsSync(CONFIG.huntsFile) ? JSON.parse(fs.readFileSync(CONFIG.huntsFile, 'utf8')) : [];
        res.json(data);
    } catch (e) { res.json([]); }
});

app.get('/api/pulse/history', (req, res) => {
    try {
        const data = fs.existsSync(CONFIG.historyFile) ? JSON.parse(fs.readFileSync(CONFIG.historyFile, 'utf8')) : [];
        res.json(data);
    } catch (e) { res.json([]); }
});

function savePulse(p) {
    fs.mkdirSync(path.dirname(CONFIG.huntsFile), { recursive: true });
    let a = fs.existsSync(CONFIG.huntsFile) ? JSON.parse(fs.readFileSync(CONFIG.huntsFile, 'utf8')) : [];
    a.push(p);
    fs.writeFileSync(CONFIG.huntsFile, JSON.stringify(a, null, 2));
}

function saveHistory(p) {
    let h = fs.existsSync(CONFIG.historyFile) ? JSON.parse(fs.readFileSync(CONFIG.historyFile, 'utf8')) : [];
    h.push(p);
    fs.writeFileSync(CONFIG.historyFile, JSON.stringify(h, null, 2));
}

// --- BOOT ---
(async () => {
    log('--- NUCLEAR LIQUIDATION SNIPER STARTING (1x) ---');
    await fetchTopSymbols(100);
    connect();
    
    app.listen(3009, '0.0.0.0', () => {
        log('📊 Pulse Terminal online at http://localhost:3009');
    });

    setInterval(() => fetchTopSymbols(100), CONFIG.scanIntervalMs);
})();
