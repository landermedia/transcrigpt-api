require("dotenv").config();

const express = require("express");
const multer = require("multer");
const ffmpeg = require("fluent-ffmpeg");
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const FormData = require("form-data");
const tmp = require("tmp");
const cors = require("cors");

const app = express();

app.use(cors());

const upload = multer({
  storage: multer.memoryStorage(),
  fileFilter: (req, file, cb) => {
    const acceptedMimeTypes = [
      "audio/mpeg",
      "audio/wav",
      "audio/mp3",
      "video/mp4",
      "video/mpeg",
      "video/quicktime",
      "video/x-msvideo",
    ];

    if (acceptedMimeTypes.includes(file.mimetype)) {
      cb(null, true); // Accept the file
    } else {
      cb(
        new Error("Invalid file type. Only audio and video files are allowed."),
        false
      ); // Reject the file
    }
  },
});

const currentDirectory = process.cwd();

async function sendAudioToApi(filePath) {
  const formData = new FormData();
  formData.append("file", fs.createReadStream(filePath));
  formData.append("model", "whisper-1");
  formData.append("timestamps", "true");

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

  console.log("[INFO] WhisperAPI translation: ", response.data);
  return response.data.text;
}

app.post("/upload", upload.single("file"), async (req, res) => {
  try {
    const fileBuffer = req.file.buffer;
    const maxSegmentSize = 25 * 1024 * 1024; // 25 MB

    // Create a temporary file and write the buffer to it
    const tmpFile = tmp.fileSync();
    fs.writeFileSync(tmpFile.name, fileBuffer);

    // Automatically detect input format

    const segmentFilenames = [];
    const processFile = () =>
      new Promise((resolve, reject) => {
        const command = ffmpeg(tmpFile.name)
          .withAudioCodec("libmp3lame")
          .toFormat("mp3")
          .on("start", () =>
            console.log("Starting audio extraction and segmentation...")
          )
          .on("codecData", (data) =>
            console.log("Input codec information:", data)
          )
          .on("progress", (progress) =>
            console.log("Processing:", progress.percent + "% done")
          )
          .on("end", async () => {
            console.log("Audio extraction and segmentation finished");
            tmpFile.removeCallback(); // Clean up the temporary file

            // Populate segmentFilenames array
            let index = 0;
            console.log("hello");

            while (
              (segmentFilePath = path.join(
                currentDirectory,
                `segment-${index.toString().padStart(3, "0")}.mp3`
              )) &&
              fs.existsSync(segmentFilePath)
            ) {
              console.log(`Segmented file found: ${segmentFilePath}`);
              segmentFilenames.push(
                `segment-${index.toString().padStart(3, "0")}.mp3`
              );
              index++;
            }

            resolve();
          })
          .on("error", (err) => {
            console.error("Error:", err);
            tmpFile.removeCallback(); // Clean up the temporary file
            reject(err);
          });

        // Segment the audio stream into 25 MB chunks
        command.addOutputOptions([
          `-f segment`,
          `-segment_time ${(maxSegmentSize / 16000).toFixed(0)}`,
          `-reset_timestamps 1`,
          `-map 0:a`, // Map only the audio stream
        ]);

        // Save each segment to a file
        const segmentPattern = `segment-%03d.mp3`;
        command.save(segmentPattern);

        command.run();
      });

    // const processFileAsync = (inputFile) => {
    //   return new Promise(async (resolve, reject) => {
    //     try {
    //       const command = ffmpeg(inputFile)
    //         .withAudioCodec("libmp3lame")
    //         .toFormat("mp3")
    //         .on("start", () =>
    //           console.log("Starting audio extraction and segmentation...")
    //         )
    //         .on("codecData", (data) =>
    //           console.log("Input codec information:", data)
    //         )
    //         .on("progress", (progress) =>
    //           console.log("Processing:", progress.percent + "% done")
    //         )
    //         .on("error", (err) => {
    //           console.error("Error:", err);
    //           reject(err);
    //         });

    //       // Segment the audio stream into 25 MB chunks
    //       command.addOutputOptions([
    //         `-f segment`,
    //         `-segment_time ${(maxSegmentSize / 16000).toFixed(0)}`,
    //         `-reset_timestamps 1`,
    //         `-map 0:a`, // Map only the audio stream
    //       ]);

    //       // Save each segment to a file
    //       const segmentPattern = `segment-%03d.mp3`;
    //       console.log(
    //         "Executing ffmpeg command:",
    //         command._getArguments().join(" ")
    //       );

    //       command.save(segmentPattern);

    //       // Use promisify to convert 'end' event callback to a promise
    //       const commandEnd = promisify(command.on.bind(command), ["end"]);
    //       await commandEnd();

    //       // Populate segmentFilenames array
    //       let index = 0;
    //       while (
    //         (segmentFilePath = path.join(
    //           currentDirectory,
    //           `segment-${index.toString().padStart(3, "0")}.mp3`
    //         )) &&
    //         fs.existsSync(segmentFilePath)
    //       ) {
    //         console.log(`Segmented file found: ${segmentFilePath}`);
    //         segmentFilenames.push(
    //           `segment-${index.toString().padStart(3, "0")}.mp3`
    //         );
    //         index++;
    //       }

    //       console.log("Audio extraction and segmentation finished");
    //       tmpFile.removeCallback(); // Clean up the temporary file
    //       resolve();
    //     } catch (err) {
    //       console.error("Error:", err);
    //       tmpFile.removeCallback(); // Clean up the temporary file
    //       reject(err);
    //     }
    //   });
    // };

    await processFile();

    // fs.unlinkSync(segmentFilename); // Remove segment file after processing

    // Send segmented files to the external API
    const transcriptionPromises = segmentFilenames.map(
      async (segmentFilename) => {
        const fileBuffer = await fs.promises.readFile(
          path.join(currentDirectory, segmentFilename)
        );
        const formData = new FormData();
        formData.append("file", fileBuffer, { filename: segmentFilename });
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
          "🚀 ~ file: app.js:171 ~ app.post ~ response:",
          response.data
        );

        // fs.unlinkSync(path.join(currentDirectory, segmentFilename)); // Remove segment file after processing
        return response.data.text;
      }
    );

    const transcriptions = await Promise.all(transcriptionPromises);

    res.status(200).send({
      message: "Audio extraction and transcription completed successfully.",
      transcriptions,
    });
  } catch (err) {
    console.error(err);
    res
      .status(500)
      .send("An error occurred during audio extraction and segmentation.");
  }
});

app.post("/upload222", upload.single("file"), (req, res) => {
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

app.listen(9000, () => {
  console.log("Server is running on port 9000");
});
