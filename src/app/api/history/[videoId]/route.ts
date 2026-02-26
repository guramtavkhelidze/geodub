import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

const TEMP_DIR = path.join(process.cwd(), 'public', 'temp');

// DELETE - Remove a video and all related files
export async function DELETE(
    req: NextRequest,
    { params }: { params: Promise<{ videoId: string }> }
) {
    try {
        const { videoId } = await params;

        if (!videoId) {
            return NextResponse.json({ error: 'Video ID is required' }, { status: 400 });
        }

        const deletedFiles: string[] = [];

        if (fs.existsSync(TEMP_DIR)) {
            const files = fs.readdirSync(TEMP_DIR);

            // Delete all files that start with this videoId
            for (const file of files) {
                if (file.startsWith(videoId)) {
                    const filePath = path.join(TEMP_DIR, file);
                    try {
                        fs.unlinkSync(filePath);
                        deletedFiles.push(file);
                    } catch (err) {
                        console.error(`Failed to delete ${file}:`, err);
                    }
                }
            }

            // Also delete temp directories
            for (const file of files) {
                if (file.startsWith(`temp_${videoId}`)) {
                    const dirPath = path.join(TEMP_DIR, file);
                    try {
                        if (fs.statSync(dirPath).isDirectory()) {
                            fs.rmSync(dirPath, { recursive: true });
                            deletedFiles.push(file);
                        }
                    } catch (err) {
                        console.error(`Failed to delete directory ${file}:`, err);
                    }
                }
            }
        }

        return NextResponse.json({
            success: true,
            videoId,
            deletedFiles
        });
    } catch (error: any) {
        console.error('Error deleting video:', error);
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}
