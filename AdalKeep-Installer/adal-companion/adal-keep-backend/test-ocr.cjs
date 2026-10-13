const Tesseract = require('tesseract.js');
const fs = require('fs');
const path = require('path');

const downloads = '/home/abduhabibi/Downloads';
console.log('🔍 Scanning Downloads folder for images...');

try {
  const files = fs.readdirSync(downloads);
  const imageFile = files.find(f => f.match(/\.(jpg|jpeg|png)$/i));

  if (!imageFile) {
    console.log('❌ No image files (jpg, jpeg, png) found in Downloads.');
    console.log('👉 Please put a test image in /home/abduhabibi/Downloads and try again.');
    process.exit(1);
  }

  console.log('📄 Testing OCR on:', imageFile);
  const filePath = path.join(downloads, imageFile);

  console.log('⏳ Starting Tesseract OCR (this may take 10-20 seconds)...');
  Tesseract.recognize(filePath, 'eng+amh', {
    logger: m => {
      if (m.status === 'recognizing text') {
        process.stdout.write('\rProgress: ' + Math.round(m.progress * 100) + '%');
      }
    }
  }).then(({ data: { text } }) => {
    console.log('\n✅ OCR Complete!');
    console.log('Extracted text length:', text.length, 'characters');
    console.log('--- TEXT START ---');
    console.log(text.substring(0, 800)); 
    console.log('--- TEXT END ---');
  }).catch(err => {
    console.error('\n❌ OCR Failed:', err.message);
  });
} catch (err) {
  console.error('Error reading Downloads folder:', err.message);
}
