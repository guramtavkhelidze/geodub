import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

const DATA_DIR = path.join(process.cwd(), 'data');
const PLAYLISTS_FILE = path.join(DATA_DIR, 'playlists.json');

function readPlaylists() {
    if (!fs.existsSync(PLAYLISTS_FILE)) return [];
    try {
        return JSON.parse(fs.readFileSync(PLAYLISTS_FILE, 'utf-8'));
    } catch {
        return [];
    }
}

export async function GET() {
    return NextResponse.json({ playlists: readPlaylists() });
}

export async function POST(req: NextRequest) {
    try {
        const { playlists } = await req.json();
        if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
        fs.writeFileSync(PLAYLISTS_FILE, JSON.stringify(playlists, null, 2));
        return NextResponse.json({ success: true });
    } catch (error: any) {
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}
