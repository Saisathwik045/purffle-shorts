# Original synthetic cloud test speech

`synthetic-speech.opus` is an original verification fixture, generated in the
managed Linux cloud workspace with FFmpeg's offline libflite `slt` voice and
encoded as Opus at 16 kbit/s. No YouTube media, music, human recording or external
TTS API is used. The project's authoring session generated the following original
text solely for the user's authorized synthetic pipeline verification:

> This is a synthetic recording for a cloud video test. Every video should have readable captions and clear audio. Our small speech recognition model runs on a CPU in the cloud. The original pictures and spoken words are created only for this test. Nothing is uploaded to YouTube and no computer at home does the work.

The test builds an original solid-color picture around this audio. The fixture
avoids installing system speech/FFmpeg packages on a GitHub runner: the existing
`imageio-ffmpeg` dependency supplies CPU FFmpeg. Whisper inference, highlight
selection, subtitle timing and rendering all run for real during the cloud test.
The synthesized output is provided under the project's MIT license. Flite itself
is separately licensed software and is not redistributed by this fixture.
