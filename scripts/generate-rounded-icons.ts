import sharp from "sharp";

const SOURCE = "public/web-app-icon-512.png";
const RADIUS_RATIO = 0.21;
const OUTPUTS = [
  { path: "src/app/icon.png", size: 32 },
  { path: "src/app/icon1.png", size: 16 },
  { path: "src/app/icon2.png", size: 48 },
  { path: "src/app/apple-icon.png", size: 180 },
  { path: "public/web-app-icon-512.png", size: 512 },
] as const;

function roundedMask(size: number) {
  const radius = Math.round(size * RADIUS_RATIO);
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">`
      + `<rect width="${size}" height="${size}" rx="${radius}" fill="#fff"/>`
      + "</svg>",
  );
}

async function main() {
  const source = await sharp(SOURCE).png().toBuffer();
  await Promise.all(OUTPUTS.map(async ({ path, size }) => {
    await sharp(source)
      .resize(size, size, { fit: "cover" })
      .composite([{ input: roundedMask(size), blend: "dest-in" }])
      .png()
      .toFile(path);
  }));
}

void main();
