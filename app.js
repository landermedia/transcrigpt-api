require("dotenv").config();

const express = require("express");
const multer = require("multer");
const ffmpeg = require("fluent-ffmpeg");
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const FormData = require("form-data");

const app = express();
const upload = multer({ dest: "uploads/" });
const maxSegmentSize = 25 * 1024 * 1024; // 25 MB

async function sendAudioToApi(filePath) {
  const formData = new FormData();
  formData.append("file", fs.createReadStream(filePath));
  formData.append("model", "whisper-1");

  const response = await axios.post(
    "https://api.openai.com/v1/audio/transcriptions",
    formData,
    {
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        ...formData.getHeaders(),
      },
    }
  );

  console.log(
    "🚀 ~ file: app.js:33 ~ sendAudioToApi ~ response.data:",
    response.data
  );
  return response.data.text;
}

app.post("/upload", upload.single("file"), (req, res) => {
  const inputFile = req.file.path;
  const fileExtension = path.extname(req.file.originalname);
  const outputDir = `output/${req.file.filename}`;
  const audioOutput = `${outputDir}/audio${fileExtension}`;

  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  ffmpeg(inputFile)
    .outputOptions("-vn")
    .save(audioOutput)
    .on("end", () => {
      ffmpeg.ffprobe(audioOutput, (err, metadata) => {
        if (err) {
          console.error("Error during ffprobe:", err);
          res.sendStatus(500);
          return;
        }

        const duration = metadata.streams[0].duration;
        const segmentDuration = Math.min(
          10,
          (maxSegmentSize / req.file.size) * duration
        );

        let counter = 0;
        ffmpeg(audioOutput)
          .outputOptions([
            `-f segment`,
            `-segment_time ${segmentDuration}`,
            `-c copy`,
          ])
          .save(`${outputDir}/segment%03d${fileExtension}`)
          .on("end", async () => {
            const segmentFiles = fs
              .readdirSync(outputDir)
              .filter((file) => file.startsWith("segment"));

            let combinedTranscript = "";
            for (const segmentFile of segmentFiles) {
              const transcript = await sendAudioToApi(
                `${outputDir}/${segmentFile}`
              );
              combinedTranscript += transcript;
            }

            // fs.writeFileSync(`${outputDir}/transcript.txt`, combinedTranscript);
            res.status(200).json({ data: combinedTranscript });
          })
          .on("error", (err) => {
            console.error("Error during processing:", err);
            res.sendStatus(500);
          });
      });
    })
    .on("error", (err) => {
      console.error("Error during audio extraction:", err);
      res.sendStatus(500);
    });
});

app.listen(3000, () => {
  console.log("Server is running on port 3000");
});
