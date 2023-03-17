require("dotenv").config();

const express = require("express");
const multer = require("multer");
const ffmpeg = require("fluent-ffmpeg");
const axios = require("axios");
const app = express();

const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static("public"));

const storage = multer.memoryStorage();
const upload = multer({
  storage: storage,
  fileFilter: function (req, file, callback) {
    const ext = file.mimetype.split("/")[0];
    if (ext !== "audio" && ext !== "video") {
      return callback(new Error("Only audio and video files are allowed"));
    }
    callback(null, true);
  },
});

app.post("/upload", upload.single("media"), async (req, res, next) => {
  try {
    const { buffer, mimetype } = req.file;

    // Extract audio from the media file
    const audio = await extractAudio(buffer, mimetype);

    // Split the audio into 10-second chunks
    const chunks = splitAudio(audio, 10);

    // Send each chunk to the API and collect the responses
    const responses = await Promise.all(chunks.map(sendToAPI));

    // Combine the responses into a single object
    const combined = responses.reduce(
      (acc, curr) => {
        acc.transcriptions.push(...curr.transcriptions);
        acc.errors.push(...curr.errors);
        return acc;
      },
      { transcriptions: [], errors: [] }
    );

    res.json(combined);
  } catch (err) {
    next(err);
  }
});

function extractAudio(buffer, mimetype) {
  return new Promise((resolve, reject) => {
    const command = ffmpeg(buffer)
      .format("wav")
      .noVideo()
      .audioChannels(1)
      .audioFrequency(16000);

    command
      .output("-")
      .on("end", (stdout) => {
        resolve(stdout);
      })
      .on("error", (err) => {
        reject(err);
      })
      .run();
  });
}

function splitAudio(audio, chunkSize) {
  const chunks = [];
  const totalDuration = ffmpeg.ffprobe(audio).format.duration;
  for (let i = 0; i < totalDuration; i += chunkSize) {
    const start = i;
    const end = Math.min(i + chunkSize, totalDuration);
    const duration = end - start;
    const chunk = ffmpeg(audio)
      .setStartTime(start)
      .setDuration(duration)
      .format("wav")
      .noVideo()
      .audioChannels(1)
      .audioFrequency(16000)
      .output("-")
      .pipe();
    chunks.push(chunk);
  }
  return chunks;
}

async function sendToAPI(chunk) {
  try {
    const config = {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "multipart/form-data",
      },
    };

    const response = axios
      .post("https://api.openai.com/v1/audio/transcriptions", form, config)
      .then((response) => {
        console.log(response.data);
      })
      .catch((error) => {
        console.error(error);
      });

    const { text: transcriptions } = response.data;
    return { transcriptions, errors: [] };
  } catch (err) {
    const message = err.response?.data?.message || err.message;
    const error = { message, chunk };
    return { transcriptions: [], errors: [error] };
  }
}

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
