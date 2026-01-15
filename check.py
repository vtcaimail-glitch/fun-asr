from funasr import AutoModel
import inspect

model = AutoModel(model="paraformer-zh")

# Xem danh sách các tham số mà hàm generate có thể nhận
print(inspect.signature(model.generate))