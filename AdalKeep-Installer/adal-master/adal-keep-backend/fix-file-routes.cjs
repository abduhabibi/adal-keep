const fs = require('fs');
const path = require('path');

const filePath = path.join(process.cwd(), 'src/routes/files.js');
let content = fs.readFileSync(filePath, 'utf8');

// 1. Fix the download route
const downloadRoute = `router.get('/files/:fileId/download', async (req, res) => {
  try {
    const { fileId } = req.params
    const db = req.app.locals.db
    const file = await db('files').where('id', fileId).first()
    if (!file) return res.status(404).json({ error: 'File not found' })

    const fullPath = path.join(__dirname, '../../data/SafeStorage', file.path)
    if (!fs.existsSync(fullPath)) return res.status(404).json({ error: 'File not found on disk' })
    
    res.download(fullPath, file.original_name)
  } catch (err) {
    console.error('Download error:', err)
    res.status(500).json({ error: 'Failed to download file' })
  }
})`;

// 2. Fix the thumbnail route
const thumbnailRoute = `router.get('/files/:fileId/thumbnail', async (req, res) => {
  try {
    const { fileId } = req.params
    const db = req.app.locals.db
    const file = await db('files').where('id', fileId).first()
    if (!file) return res.status(404).json({ error: 'File not found' })

    const fullPath = path.join(__dirname, '../../data/SafeStorage', file.path)
    if (!fs.existsSync(fullPath)) return res.status(404).json({ error: 'File not found on disk' })
    
    // Send the file directly (works for images and PDFs)
    res.sendFile(fullPath)
  } catch (err) {
    console.error('Thumbnail error:', err)
    res.status(500).json({ error: 'Failed to load thumbnail' })
  }
})`;

// Simple regex replacement to overwrite the old broken routes
content = content.replace(/router\.get\('\/files\/:fileId\/download'[\s\S]*?\n\}\)/, downloadRoute);
content = content.replace(/router\.get\('\/files\/:fileId\/thumbnail'[\s\S]*?\n\}\)/, thumbnailRoute);

fs.writeFileSync(filePath, content);
console.log('✅ File routes completely fixed!');
