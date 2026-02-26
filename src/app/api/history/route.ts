import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

const TEMP_DIR = path.join(process.cwd(), 'public', 'temp');

// GET - List all generated videos
export async function GET() {
    try {
        if (!fs.existsSync(TEMP_DIR)) {
            return NextResponse.json({ videos: [] });
        }

        const files = fs.readdirSync(TEMP_DIR);

        // Find all *_georgian.mp3 files (these are the final outputs)
        const georgianFiles = files.filter(f => f.endsWith('_georgian.mp3'));

        const videos = georgianFiles.map(file => {
            const videoId = file.replace('_georgian.mp3', '');
            const audioPath = path.join(TEMP_DIR, file);
            const metaPath = path.join(TEMP_DIR, `${videoId}_meta.json`);
            const stats = fs.statSync(audioPath);

            // Try to read metadata from JSON file
            let metadata: any = {};
            if (fs.existsSync(metaPath)) {
                try {
                    metadata = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
                } catch {}
            }

            return {
                videoId,
                audioUrl: `/temp/${file}`,
                createdAt: metadata.createdAt || stats.mtime.toISOString(),
                title: metadata.title || null,
                thumbnail: metadata.thumbnail || null,
            };
        });

        // Sort by creation date (newest first)
        videos.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

        return NextResponse.json({ videos });
    } catch (error: any) {
        console.error('Error listing videos:', error);
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}
