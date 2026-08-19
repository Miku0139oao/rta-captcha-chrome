// Command generate-test-fixture reproduces the upstream Go OCR test image,
// JPEG-decodes it, and stores portable RGBA bytes for the dependency-free
// Node test suite.
package main

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"image"
	"image/color"
	"image/draw"
	"image/jpeg"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
)

const (
	templateWidth  = 15
	templateHeight = 21
)

type fixture struct {
	Width      int    `json:"width"`
	Height     int    `json:"height"`
	RGBABase64 string `json:"rgbaBase64"`
}

func main() {
	if len(os.Args) < 2 {
		panic("usage: go run scripts/generate-test-fixture.go <path-to-rta-sales-client-go>")
	}
	sourceRoot := os.Args[1]
	sourcePath := filepath.Join(sourceRoot, "rtasales", "embedded_ocr_learned.go")
	source, err := os.ReadFile(sourcePath)
	if err != nil {
		panic(err)
	}

	answer := "0be7f"
	width, height := len(answer)*20, 30
	canvas := image.NewRGBA(image.Rect(0, 0, width, height))
	draw.Draw(canvas, canvas.Bounds(), image.NewUniform(color.White), image.Point{}, draw.Src)
	palette := []color.RGBA{
		{R: 40, G: 105, B: 170, A: 255},
		{R: 150, G: 45, B: 75, A: 255},
		{R: 55, G: 130, B: 70, A: 255},
		{R: 105, G: 55, B: 155, A: 255},
		{R: 165, G: 105, B: 25, A: 255},
	}

	for index := range len(answer) {
		encoded, err := firstTemplate(source, answer[index])
		if err != nil {
			panic(err)
		}
		packed, err := base64.StdEncoding.DecodeString(encoded)
		if err != nil {
			panic(err)
		}
		for y := range templateHeight {
			for x := range templateWidth {
				position := y*templateWidth + x
				if packed[position/8]&(1<<uint(position%8)) != 0 {
					canvas.SetRGBA(index*20+3+x, 4+y, palette[index])
				}
			}
		}
	}

	var encoded bytes.Buffer
	if err := jpeg.Encode(&encoded, canvas, &jpeg.Options{Quality: 95}); err != nil {
		panic(err)
	}
	decoded, err := jpeg.Decode(bytes.NewReader(encoded.Bytes()))
	if err != nil {
		panic(err)
	}
	rgba := make([]byte, 0, width*height*4)
	for y := range height {
		for x := range width {
			red, green, blue, alpha := decoded.At(x, y).RGBA()
			rgba = append(rgba, byte(red>>8), byte(green>>8), byte(blue>>8), byte(alpha>>8))
		}
	}

	_, scriptPath, _, _ := runtime.Caller(0)
	fixtureDirectory := filepath.Join(filepath.Dir(scriptPath), "..", "test", "fixtures")
	writeFixture(filepath.Join(fixtureDirectory, "synthetic-0be7f.json"), fixture{
		Width:      width,
		Height:     height,
		RGBABase64: base64.StdEncoding.EncodeToString(rgba),
	})

	testSource, err := os.ReadFile(filepath.Join(sourceRoot, "rtasales", "embedded_ocr_test.go"))
	if err != nil {
		panic(err)
	}
	noisePattern := regexp.MustCompile(`const colorNoiseCaptchaBase64 = "([A-Za-z0-9+/=]+)"`)
	noiseMatch := noisePattern.FindSubmatch(testSource)
	if len(noiseMatch) != 2 {
		panic("color noise fixture not found")
	}
	noiseJPEG, err := base64.StdEncoding.DecodeString(string(noiseMatch[1]))
	if err != nil {
		panic(err)
	}
	noiseImage, err := jpeg.Decode(bytes.NewReader(noiseJPEG))
	if err != nil {
		panic(err)
	}
	writeFixture(
		filepath.Join(fixtureDirectory, "color-noise-e2c63.json"),
		fixtureFromImage(noiseImage),
	)
	fmt.Println(fixtureDirectory)
}

func fixtureFromImage(source image.Image) fixture {
	bounds := source.Bounds()
	rgba := make([]byte, 0, bounds.Dx()*bounds.Dy()*4)
	for y := bounds.Min.Y; y < bounds.Max.Y; y++ {
		for x := bounds.Min.X; x < bounds.Max.X; x++ {
			red, green, blue, alpha := source.At(x, y).RGBA()
			rgba = append(rgba, byte(red>>8), byte(green>>8), byte(blue>>8), byte(alpha>>8))
		}
	}
	return fixture{
		Width:      bounds.Dx(),
		Height:     bounds.Dy(),
		RGBABase64: base64.StdEncoding.EncodeToString(rgba),
	}
}

func writeFixture(outputPath string, value fixture) {
	output, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		panic(err)
	}
	if err := os.MkdirAll(filepath.Dir(outputPath), 0o755); err != nil {
		panic(err)
	}
	if err := os.WriteFile(outputPath, append(output, '\n'), 0o644); err != nil {
		panic(err)
	}
}

func firstTemplate(source []byte, character byte) (string, error) {
	pattern := regexp.MustCompile(fmt.Sprintf(`(?m)'%c':\s*\{\s*"([A-Za-z0-9+/=]+)"`, character))
	match := pattern.FindSubmatch(source)
	if len(match) != 2 {
		return "", fmt.Errorf("template %q not found", character)
	}
	return string(match[1]), nil
}
