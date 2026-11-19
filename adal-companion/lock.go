package main

// lock.go — the backup's lock, the same as the main PC's (telegramBackup.js
// lock/unlock): AES-256-GCM with a key from scrypt (N=16384, r=8, p=1, as
// Node's crypto.scryptSync), laid out as
//
//	"ADALBK1" | salt (16) | iv (12) | tag (16) | ciphertext
//
// The Companion only locks its backup index with it: every other piece of
// its copy came locked from the main PC and is kept and sent as it is.
// (scrypt is written out here: golang.org/x/crypto is not in this module.)

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"math/bits"
)

var lockMagic = []byte("ADALBK1")

func lockPiece(plain []byte, password string) ([]byte, error) {
	salt := make([]byte, 16)
	iv := make([]byte, 12)
	if _, err := rand.Read(salt); err != nil {
		return nil, err
	}
	if _, err := rand.Read(iv); err != nil {
		return nil, err
	}
	key := scryptKey([]byte(password), salt, 16384, 8, 1, 32)
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	sealed := gcm.Seal(nil, iv, plain, nil) // ciphertext | tag
	ct, tag := sealed[:len(sealed)-16], sealed[len(sealed)-16:]
	out := make([]byte, 0, 7+16+12+16+len(ct))
	out = append(out, lockMagic...)
	out = append(out, salt...)
	out = append(out, iv...)
	out = append(out, tag...)
	return append(out, ct...), nil
}

func unlockPiece(buf []byte, password string) ([]byte, error) {
	if len(buf) < 51 || string(buf[:7]) != string(lockMagic) {
		return nil, errors.New("not an Adal Keep backup piece")
	}
	salt, iv, tag, ct := buf[7:23], buf[23:35], buf[35:51], buf[51:]
	block, err := aes.NewCipher(scryptKey([]byte(password), salt, 16384, 8, 1, 32))
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	plain, err := gcm.Open(nil, iv, append(append([]byte{}, ct...), tag...), nil)
	if err != nil {
		return nil, errors.New("wrong backup password (or a damaged piece)")
	}
	return plain, nil
}

// ── scrypt (RFC 7914) ───────────────────────────────────────────────────────

func pbkdf2SHA256(password, salt []byte, iter, keyLen int) []byte {
	prf := hmac.New(sha256.New, password)
	out := make([]byte, 0, keyLen)
	var buf [4]byte
	for block := uint32(1); len(out) < keyLen; block++ {
		prf.Reset()
		prf.Write(salt)
		binary.BigEndian.PutUint32(buf[:], block)
		prf.Write(buf[:])
		u := prf.Sum(nil)
		t := append([]byte{}, u...)
		for i := 1; i < iter; i++ {
			prf.Reset()
			prf.Write(u)
			u = prf.Sum(u[:0])
			for j := range t {
				t[j] ^= u[j]
			}
		}
		out = append(out, t...)
	}
	return out[:keyLen]
}

func salsa208(b *[16]uint32) {
	x := *b
	for i := 0; i < 8; i += 2 {
		x[4] ^= bits.RotateLeft32(x[0]+x[12], 7)
		x[8] ^= bits.RotateLeft32(x[4]+x[0], 9)
		x[12] ^= bits.RotateLeft32(x[8]+x[4], 13)
		x[0] ^= bits.RotateLeft32(x[12]+x[8], 18)
		x[9] ^= bits.RotateLeft32(x[5]+x[1], 7)
		x[13] ^= bits.RotateLeft32(x[9]+x[5], 9)
		x[1] ^= bits.RotateLeft32(x[13]+x[9], 13)
		x[5] ^= bits.RotateLeft32(x[1]+x[13], 18)
		x[14] ^= bits.RotateLeft32(x[10]+x[6], 7)
		x[2] ^= bits.RotateLeft32(x[14]+x[10], 9)
		x[6] ^= bits.RotateLeft32(x[2]+x[14], 13)
		x[10] ^= bits.RotateLeft32(x[6]+x[2], 18)
		x[3] ^= bits.RotateLeft32(x[15]+x[11], 7)
		x[7] ^= bits.RotateLeft32(x[3]+x[15], 9)
		x[11] ^= bits.RotateLeft32(x[7]+x[3], 13)
		x[15] ^= bits.RotateLeft32(x[11]+x[7], 18)
		x[1] ^= bits.RotateLeft32(x[0]+x[3], 7)
		x[2] ^= bits.RotateLeft32(x[1]+x[0], 9)
		x[3] ^= bits.RotateLeft32(x[2]+x[1], 13)
		x[0] ^= bits.RotateLeft32(x[3]+x[2], 18)
		x[6] ^= bits.RotateLeft32(x[5]+x[4], 7)
		x[7] ^= bits.RotateLeft32(x[6]+x[5], 9)
		x[4] ^= bits.RotateLeft32(x[7]+x[6], 13)
		x[5] ^= bits.RotateLeft32(x[4]+x[7], 18)
		x[11] ^= bits.RotateLeft32(x[10]+x[9], 7)
		x[8] ^= bits.RotateLeft32(x[11]+x[10], 9)
		x[9] ^= bits.RotateLeft32(x[8]+x[11], 13)
		x[10] ^= bits.RotateLeft32(x[9]+x[8], 18)
		x[12] ^= bits.RotateLeft32(x[15]+x[14], 7)
		x[13] ^= bits.RotateLeft32(x[12]+x[15], 9)
		x[14] ^= bits.RotateLeft32(x[13]+x[12], 13)
		x[15] ^= bits.RotateLeft32(x[14]+x[13], 18)
	}
	for i := range b {
		b[i] += x[i]
	}
}

// blockMix: B (2r blocks of 16 words) → Y, even blocks first, then odd.
func blockMix(b, y []uint32, r int) {
	var x [16]uint32
	copy(x[:], b[(2*r-1)*16:])
	for i := 0; i < 2*r; i++ {
		for j := 0; j < 16; j++ {
			x[j] ^= b[i*16+j]
		}
		salsa208(&x)
		off := (i/2)*16 + (i%2)*r*16
		copy(y[off:off+16], x[:])
	}
}

func scryptKey(password, salt []byte, n, r, p, keyLen int) []byte {
	b := pbkdf2SHA256(password, salt, 1, p*128*r)
	words := 32 * r
	x := make([]uint32, words)
	y := make([]uint32, words)
	v := make([]uint32, words*n)
	for i := 0; i < p; i++ {
		blk := b[i*128*r : (i+1)*128*r]
		for j := range x {
			x[j] = binary.LittleEndian.Uint32(blk[j*4:])
		}
		for k := 0; k < n; k++ {
			copy(v[k*words:], x)
			blockMix(x, y, r)
			x, y = y, x
		}
		for k := 0; k < n; k++ {
			j := int(x[(2*r-1)*16] & uint32(n-1))
			for t := range x {
				x[t] ^= v[j*words+t]
			}
			blockMix(x, y, r)
			x, y = y, x
		}
		for j := range x {
			binary.LittleEndian.PutUint32(blk[j*4:], x[j])
		}
	}
	return pbkdf2SHA256(password, b, 1, keyLen)
}
