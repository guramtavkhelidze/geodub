import { NextRequest } from 'next/server';
import { setCancelled } from '@/services/cancellation';
import path from 'path';
import fs from 'fs';

export async function POST(req: NextRequest) {
    const { jobId, videoId } = await req.json();

    if (jobId) {
        setCancelled(jobId);
    }

    if (videoId) {
        try {
            const outputDir = path.join(process.cwd(), 'public', 'temp');
            if (fs.existsSync(outputDir)) {
                const files = fs.readdirSync(outputDir);
                for (const file of files) {
                    if (file.startsWith(videoId)) {
                        try { fs.unlinkSync(path.join(outputDir, file)); } catch {}
                    }
                }
            }
        } catch (err) {
            console.error('Cleanup error:', err);
        }
    }

    return Response.json({ success: true });
}
