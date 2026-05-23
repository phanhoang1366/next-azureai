"use client";

import { Fragment, useEffect, useRef, useState } from "react";
import * as SpeechSDK from "microsoft-cognitiveservices-speech-sdk";
import styles from "./page.module.css";

const REFERENCE_TEXT = "Cho em một suất bún chả nhé";
const REFERENCE_WORDS = REFERENCE_TEXT.split(/\s+/);

type WordMark = "none" | "omission" | "mispronunciation";

type AssessmentScores = {
  total: number;
  accuracy: number;
  completeness: number;
  fluency: number;
};

type EvaluatedWord = {
  word: string;
  mark: WordMark;
};

type AssessmentView = {
  words: EvaluatedWord[];
  insertionsBeforeWord: number[];
};

type AssessmentWord = {
  Word?: string;
  PronunciationAssessment?: {
    ErrorType?: string;
  };
};

function normalizeWord(word: string): string {
  return word.toLowerCase().replace(/[.,!?;:"'“”‘’]/g, "");
}

function toWavBuffer(audioBuffer: AudioBuffer): ArrayBuffer {
  const numberOfChannels = audioBuffer.numberOfChannels;
  const sampleRate = audioBuffer.sampleRate;
  const samples = audioBuffer.length;
  const bytesPerSample = 2;
  const blockAlign = numberOfChannels * bytesPerSample;
  const wavBuffer = new ArrayBuffer(44 + samples * blockAlign);
  const view = new DataView(wavBuffer);

  const writeString = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index += 1) {
      view.setUint8(offset + index, value.charCodeAt(index));
    }
  };

  writeString(0, "RIFF");
  view.setUint32(4, 36 + samples * blockAlign, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numberOfChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bytesPerSample * 8, true);
  writeString(36, "data");
  view.setUint32(40, samples * blockAlign, true);

  let offset = 44;
  for (let index = 0; index < samples; index += 1) {
    for (let channel = 0; channel < numberOfChannels; channel += 1) {
      const sample = audioBuffer.getChannelData(channel)[index];
      const clamped = Math.max(-1, Math.min(1, sample));
      view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
      offset += bytesPerSample;
    }
  }

  return wavBuffer;
}

async function recordedBlobToWavFile(blob: Blob): Promise<File> {
  const audioContext = new AudioContext();
  try {
    const arrayBuffer = await blob.arrayBuffer();
    const decoded = await audioContext.decodeAudioData(arrayBuffer.slice(0));
    const wavBuffer = toWavBuffer(decoded);
    return new File([wavBuffer], "recorded-audio.wav", { type: "audio/wav" });
  } finally {
    await audioContext.close();
  }
}

function mapAssessmentToReference(assessmentWords: AssessmentWord[]): AssessmentView {
  const words: EvaluatedWord[] = REFERENCE_WORDS.map((word) => ({ word, mark: "none" }));
  const insertionsBeforeWord = new Array(REFERENCE_WORDS.length + 1).fill(0);

  let referenceIndex = 0;

  for (const assessmentWord of assessmentWords) {
    const errorType = assessmentWord?.PronunciationAssessment?.ErrorType?.toLowerCase() ?? "";

    if (errorType === "insertion") {
      insertionsBeforeWord[Math.min(referenceIndex, REFERENCE_WORDS.length)] += 1;
      continue;
    }

    if (referenceIndex >= REFERENCE_WORDS.length) {
      continue;
    }

    const spokenWord = normalizeWord(assessmentWord.Word ?? "");
    let matchedIndex = -1;

    for (let index = referenceIndex; index < REFERENCE_WORDS.length; index += 1) {
      if (normalizeWord(REFERENCE_WORDS[index]) === spokenWord) {
        matchedIndex = index;
        break;
      }
    }

    if (matchedIndex === -1) {
      if (errorType === "omission") {
        words[referenceIndex].mark = "omission";
      } else if (errorType === "mispronunciation") {
        words[referenceIndex].mark = "mispronunciation";
      }
      referenceIndex += 1;
      continue;
    }

    for (let index = referenceIndex; index < matchedIndex; index += 1) {
      words[index].mark = "omission";
    }

    if (errorType === "omission") {
      words[matchedIndex].mark = "omission";
    } else if (errorType === "mispronunciation") {
      words[matchedIndex].mark = "mispronunciation";
    }

    referenceIndex = matchedIndex + 1;
  }

  return { words, insertionsBeforeWord };
}

function createRecognizer(audioFile: File, token: string, region: string) {
  const speechConfig = SpeechSDK.SpeechConfig.fromAuthorizationToken(token, region);
  speechConfig.speechRecognitionLanguage = "vi-VN";

  const audioConfig = SpeechSDK.AudioConfig.fromWavFileInput(audioFile);
  const pronunciationConfig = new SpeechSDK.PronunciationAssessmentConfig(
    REFERENCE_TEXT,
    SpeechSDK.PronunciationAssessmentGradingSystem.HundredMark,
    SpeechSDK.PronunciationAssessmentGranularity.Word,
    true,
  );

  const recognizer = new SpeechSDK.SpeechRecognizer(speechConfig, audioConfig);
  pronunciationConfig.applyTo(recognizer);

  return recognizer;
}

async function requestSpeechToken(): Promise<{ token: string; region: string }> {
  const response = await fetch("/api/speech-token", { method: "POST" });
  if (!response.ok) {
    throw new Error("Unable to fetch Azure Speech token. Check server environment variables.");
  }

  return response.json();
}

function parseScores(jsonResult: string): AssessmentScores | null {
  const parsed = JSON.parse(jsonResult);
  const pronunciation = parsed?.NBest?.[0]?.PronunciationAssessment;

  if (!pronunciation) {
    return null;
  }

  return {
    total: Number(pronunciation.PronScore ?? 0),
    accuracy: Number(pronunciation.AccuracyScore ?? 0),
    completeness: Number(pronunciation.CompletenessScore ?? 0),
    fluency: Number(pronunciation.FluencyScore ?? 0),
  };
}

function parseWords(jsonResult: string): AssessmentWord[] {
  const parsed = JSON.parse(jsonResult);
  return parsed?.NBest?.[0]?.Words ?? [];
}

export default function Home() {
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);

  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [recordedBlob, setRecordedBlob] = useState<Blob | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [scores, setScores] = useState<AssessmentScores | null>(null);
  const [assessmentView, setAssessmentView] = useState<AssessmentView>({
    words: REFERENCE_WORDS.map((word) => ({ word, mark: "none" })),
    insertionsBeforeWord: new Array(REFERENCE_WORDS.length + 1).fill(0),
  });

  useEffect(() => {
    return () => {
      streamRef.current?.getTracks().forEach((track) => track.stop());
      if (audioUrl) {
        URL.revokeObjectURL(audioUrl);
      }
    };
  }, [audioUrl]);

  const resetRecording = () => {
    setErrorMessage(null);
    setScores(null);
    setAssessmentView({
      words: REFERENCE_WORDS.map((word) => ({ word, mark: "none" })),
      insertionsBeforeWord: new Array(REFERENCE_WORDS.length + 1).fill(0),
    });

    if (audioUrl) {
      URL.revokeObjectURL(audioUrl);
      setAudioUrl(null);
    }

    setRecordedBlob(null);
    audioChunksRef.current = [];
  };

  const handleRecord = async () => {
    setErrorMessage(null);

    if (isRecording) {
      mediaRecorderRef.current?.stop();
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      setIsRecording(false);
      return;
    }

    try {
      resetRecording();
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const mediaRecorder = new MediaRecorder(stream);
      mediaRecorderRef.current = mediaRecorder;
      audioChunksRef.current = [];

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };

      mediaRecorder.onstop = () => {
        const blob = new Blob(audioChunksRef.current, { type: mediaRecorder.mimeType || "audio/webm" });
        setRecordedBlob(blob);
        setAudioUrl(URL.createObjectURL(blob));
      };

      mediaRecorder.start();
      setIsRecording(true);
    } catch {
      setErrorMessage("Microphone access is required to record audio.");
    }
  };

  const handleSubmit = async () => {
    if (!recordedBlob) {
      setErrorMessage("Please record audio before submitting.");
      return;
    }

    setIsSubmitting(true);
    setErrorMessage(null);

    try {
      const [{ token, region }, wavFile] = await Promise.all([
        requestSpeechToken(),
        recordedBlobToWavFile(recordedBlob),
      ]);

      const recognizer = createRecognizer(wavFile, token, region);

      const result = await new Promise<SpeechSDK.SpeechRecognitionResult>((resolve, reject) => {
        recognizer.recognizeOnceAsync(resolve, reject);
      });

      recognizer.close();

      if (result.reason !== SpeechSDK.ResultReason.RecognizedSpeech) {
        throw new Error("Speech was not recognized. Please try speaking clearly and submit again.");
      }

      const jsonResult = result.properties.getProperty(SpeechSDK.PropertyId.SpeechServiceResponse_JsonResult);
      const parsedScores = parseScores(jsonResult);
      const parsedWords = parseWords(jsonResult);

      if (!parsedScores) {
        throw new Error("Unable to parse pronunciation scores from Azure Speech response.");
      }

      setScores(parsedScores);
      setAssessmentView(mapAssessmentToReference(parsedWords));
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Pronunciation assessment failed.");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <main className={styles.page}>
      <section className={styles.card}>
        <h1>Vietnamese Pronunciation Assessment</h1>
        <p className={styles.subtitle}>Reference sentence:</p>
        <div className={styles.referenceSentence}>
          {assessmentView.words.map(({ word, mark }, index) => (
            <Fragment key={`${word}-${index}`}>
              {assessmentView.insertionsBeforeWord[index] > 0 ? (
                <span className={styles.insertionLine} aria-label="insertion marker" />
              ) : null}
              <span
                className={`${styles.word} ${
                  mark === "omission"
                    ? styles.omission
                    : mark === "mispronunciation"
                      ? styles.mispronunciation
                      : ""
                }`}
              >
                {word}
              </span>
            </Fragment>
          ))}
          {assessmentView.insertionsBeforeWord[assessmentView.insertionsBeforeWord.length - 1] > 0 ? (
            <span className={styles.insertionLine} aria-label="insertion marker" />
          ) : null}
        </div>

        <div className={styles.actions}>
          <button type="button" onClick={handleRecord} className={styles.button}>
            {isRecording ? "Stop recording" : "Record"}
          </button>
          <button
            type="button"
            onClick={() => {
              if (audioUrl) {
                const audio = new Audio(audioUrl);
                audio.play().catch(() => setErrorMessage("Playback failed. Please try again."));
              }
            }}
            disabled={!audioUrl || isRecording}
            className={styles.button}
          >
            Play
          </button>
          <button type="button" onClick={resetRecording} disabled={isRecording} className={styles.button}>
            Restart
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={!recordedBlob || isRecording || isSubmitting}
            className={styles.button}
          >
            {isSubmitting ? "Submitting..." : "Submit"}
          </button>
        </div>

        {audioUrl ? <audio src={audioUrl} controls className={styles.audioPlayer} /> : null}
        {errorMessage ? <p className={styles.error}>{errorMessage}</p> : null}

        {scores ? (
          <section className={styles.scores}>
            <h2>Scores</h2>
            <p>
              <strong>Total:</strong> {scores.total.toFixed(2)}
            </p>
            <p>
              <strong>Accuracy:</strong> {scores.accuracy.toFixed(2)}
            </p>
            <p>
              <strong>Completeness:</strong> {scores.completeness.toFixed(2)}
            </p>
            <p>
              <strong>Fluency:</strong> {scores.fluency.toFixed(2)}
            </p>
          </section>
        ) : null}
      </section>
    </main>
  );
}
