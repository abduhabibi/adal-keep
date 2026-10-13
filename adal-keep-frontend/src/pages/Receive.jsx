import { useState, useRef, useEffect } from 'react';
import { Html5QrcodeScanner } from 'html5-qrcode';
import jsQR from 'jsqr';
import api from '../services/api';
import toast from 'react-hot-toast';

export default function Receive() {
  const [mode, setMode] = useState('camera'); // 'camera' or 'upload'
  const [scannedFaydaId, setScannedFaydaId] = useState('');
  const [amount, setAmount] = useState(5000); // Auto-set to 5000 Birr for Fayda
  const [isProcessing, setIsProcessing] = useState(false);
  const fileInputRef = useRef(null);
  const scannerRef = useRef(null);

  // Initialize Camera Scanner
  useEffect(() => {
    if (mode === 'camera' && !scannedFaydaId && !scannerRef.current) {
      const scanner = new Html5QrcodeScanner('reader', {
        fps: 10,
        qrbox: { width: 250, height: 250 },
        aspectRatio: 1.0,
      }, false);
      
      scanner.render(
        (decodedText) => {
          handleScanSuccess(decodedText);
          scanner.clear().catch(() => {});
          scannerRef.current = null;
        },
        () => { /* Ignore frame errors */ }
      );
      scannerRef.current = scanner;
    }

    return () => {
      if (scannerRef.current) {
        scannerRef.current.clear().catch(() => {});
        scannerRef.current = null;
      }
    };
  }, [mode, scannedFaydaId]);

  const handleScanSuccess = (text) => {
    // Check if it's a Fayda QR code (adjust regex/logic if Fayda has a specific prefix)
    if (text.includes('FAYDA') || text.match(/^[A-Z0-9-]{10,}$/)) {
      setScannedFaydaId(text);
      setAmount(5000); // Automatically set to 5000 Birr as requested
      toast.success('Fayda ID Detected! Amount set to 5000 Birr.');
    } else {
      toast.error('Not a valid Fayda QR code.');
    }
  };

  const handleImageUpload = async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const imageUrl = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = image.width;
      canvas.height = image.height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(image, 0, 0);
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const code = jsQR(imageData.data, imageData.width, imageData.height);

      if (code) {
        handleScanSuccess(code.data);
      } else {
        toast.error('Could not read QR code from image.');
      }
      URL.revokeObjectURL(imageUrl);
    };
    image.src = imageUrl;
  };

  const processPayment = async () => {
    if (!scannedFaydaId) return toast.error('No Fayda ID scanned.');
    setIsProcessing(true);
    try {
      const res = await api.post('/payments/receive-fayda', {
        faydaId: scannedFaydaId,
        amount: amount
      });
      toast.success(`Successfully received ${amount} Birr!`);
      setScannedFaydaId('');
      setAmount(5000);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Payment failed.');
    } finally {
      setIsProcessing(false);
    }
  };

  return (
    <div className="p-6 max-w-md mx-auto min-h-screen bg-gray-50">
      <h2 className="text-2xl font-bold mb-6 text-center text-gray-800">Receive Payment</h2>
      
      {/* Mode Selector: Camera vs Upload */}
      <div className="flex gap-2 mb-6 bg-gray-200 p-1 rounded-xl">
        <button 
          onClick={() => { setMode('camera'); setScannedFaydaId(''); }}
          className={`flex-1 py-3 rounded-lg font-semibold transition ${mode === 'camera' ? 'bg-blue-600 text-white shadow' : 'text-gray-600'}`}
        >
          📷 Scan Camera
        </button>
        <button 
          onClick={() => { setMode('upload'); setScannedFaydaId(''); }}
          className={`flex-1 py-3 rounded-lg font-semibold transition ${mode === 'upload' ? 'bg-blue-600 text-white shadow' : 'text-gray-600'}`}
        >
          🖼️ Upload QR
        </button>
      </div>

      {/* Camera View */}
      {mode === 'camera' && !scannedFaydaId && (
        <div className="border-2 border-dashed border-gray-300 rounded-2xl p-4 bg-black flex flex-col items-center">
          <div id="reader" className="w-full rounded-xl overflow-hidden" style={{ minWidth: '300px', minHeight: '300px' }}></div>
          <p className="text-white text-center mt-3 text-sm font-medium">Point camera at Fayda QR Code</p>
        </div>
      )}

      {/* Upload View */}
      {mode === 'upload' && !scannedFaydaId && (
        <div 
          onClick={() => fileInputRef.current.click()}
          className="border-2 border-dashed border-blue-400 rounded-2xl p-10 text-center cursor-pointer hover:bg-blue-50 transition bg-white"
        >
          <input type="file" ref={fileInputRef} accept="image/*" className="hidden" onChange={handleImageUpload} />
          <div className="text-5xl mb-3">📁</div>
          <p className="text-gray-700 font-bold">Tap to select QR Code image</p>
          <p className="text-gray-500 text-sm mt-1">From the other person's phone</p>
        </div>
      )}

      {/* Success / Confirmation View */}
      {scannedFaydaId && (
        <div className="bg-green-50 border-2 border-green-200 rounded-2xl p-6 text-center animate-fade-in shadow-lg">
          <div className="text-5xl mb-3">✅</div>
          <h3 className="text-xl font-bold text-green-800 mb-1">Fayda ID Verified</h3>
          <p className="text-gray-600 text-sm mb-4 break-all font-mono bg-white p-2 rounded">{scannedFaydaId}</p>
          
          <div className="bg-white rounded-xl p-4 mb-4 shadow-sm border border-gray-100">
            <p className="text-gray-500 text-sm uppercase tracking-wide">Amount to Receive</p>
            <p className="text-4xl font-extrabold text-blue-600 mt-1">{amount} Birr</p>
          </div>

          <button
            onClick={processPayment}
            disabled={isProcessing}
            className="w-full bg-blue-600 text-white py-4 rounded-xl font-bold text-lg hover:bg-blue-700 transition disabled:opacity-50 shadow-md"
          >
            {isProcessing ? 'Processing Deduction...' : `Confirm & Receive ${amount} Birr`}
          </button>
          
          <button 
            onClick={() => { setScannedFaydaId(''); setAmount(5000); }}
            className="mt-4 text-gray-500 text-sm font-medium hover:text-blue-600 transition"
          >
            ← Scan Different Code
          </button>
        </div>
      )}
    </div>
  );
}
