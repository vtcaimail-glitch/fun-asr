from funasr import AutoModel


def main() -> None:
    audio_path = r"D:\0_code\3.Full-pipeline\fun-asr\Hệ thống muộn_fixed.16k.mono.wav"
    text_path = r"D:\0_code\3.Full-pipeline\fun-asr\Hệ thống muộn_fixed.16k.mono.funasr.txt"

    model = AutoModel(model="fa-zh", model_revision="v2.0.4")
    res = model.generate(input=(audio_path, text_path), data_type=("sound", "text"))
    print(res)


if __name__ == "__main__":
    main()

