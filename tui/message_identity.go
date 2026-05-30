package main

import (
	"crypto/sha256"
	"encoding/hex"
)

func messageIdentityHash(role, content string) string {
	sum := sha256.New()
	sum.Write([]byte(role))
	sum.Write([]byte{0})
	sum.Write([]byte(content))
	return hex.EncodeToString(sum.Sum(nil))
}
