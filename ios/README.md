# CamSweep — App iOS phát hiện camera ẩn

App iOS đơn giản giúp bạn kiểm tra phòng khách sạn / Airbnb xem có camera quay lén hay không. Không cần server, không thu thập dữ liệu, chạy hoàn toàn trên máy.

## Yêu cầu

- macOS + **Xcode 16 trở lên**
- **iPhone thật** chạy iOS 17+ (simulator không có camera, từ kế hay Wi-Fi thật nên gần như không dùng được)
- Tài khoản Apple ID (miễn phí) để ký app khi cài lên máy

## Cách build & cài lên iPhone

1. Mở `ios/CamSweep.xcodeproj` bằng Xcode.
2. Chọn target **CamSweep** → tab **Signing & Capabilities** → chọn **Team** của bạn (đăng nhập Apple ID nếu chưa có). Nếu trùng bundle ID, đổi `com.example.camsweep` thành chuỗi riêng của bạn.
3. Cắm iPhone, chọn nó làm thiết bị chạy, bấm **Run** (⌘R).
4. Lần đầu chạy, vào iPhone: *Settings → General → VPN & Device Management* → tin tưởng (Trust) developer profile của bạn.

## 4 công cụ trong app

### 1. IR Scan (quét hồng ngoại)
Hầu hết camera quay lén có đèn LED hồng ngoại để quay ban đêm — mắt thường không thấy nhưng camera điện thoại thấy được (hiện thành đốm sáng trắng/tím).

- **Tắt hết đèn, kéo rèm** cho phòng tối hẳn.
- Lia điện thoại chậm quanh phòng; app tự khoanh đỏ các đốm sáng bất thường.
- **Tự kiểm chứng:** chĩa remote TV vào camera điện thoại và bấm nút bất kỳ — nếu thấy đầu remote nháy sáng trên màn hình nghĩa là tính năng hoạt động. (Camera trước thường "thấy" hồng ngoại tốt hơn camera sau.)
- Chuyển sang camera sau + bật đèn pin (nút trên góc phải) để soi **phản xạ ống kính**: ống kính camera phản chiếu ánh sáng thành chấm sáng nhỏ.

### 2. Magnetic Scan (đo từ trường)
Camera đang cắm điện, nam châm gắn camera, biến áp... làm nhiễu từ trường ở khoảng cách rất gần (2–5 cm).

- Đứng giữa phòng, bấm **Reset baseline** để lấy mốc.
- Đưa **cạnh trên** điện thoại sát các vật khả nghi: đầu báo khói, đồng hồ, củ sạc, khe thông gió, khung ảnh.
- Kim vọt lên đột ngột = có đồ điện tử/nam châm bên trong. Lưu ý ống nước kim loại, loa, TV cũng làm kim nhảy — đây là manh mối, không phải bằng chứng.

### 3. Network Scan (quét Wi-Fi)
Quét dải mạng Wi-Fi đang kết nối tìm thiết bị mở các cổng mà camera IP hay dùng (RTSP 554/8554, web 80/443/8080) và các dịch vụ Bonjour được quảng bá.

- Kết nối Wi-Fi khách sạn rồi bấm **Scan this Wi-Fi**. Lần đầu iOS sẽ hỏi quyền **Local Network** — phải đồng ý.
- Thiết bị mở cổng **RTSP** gần như chắc chắn là camera. Thiết bị chỉ mở cổng web có thể là router/TV/máy in — bấm *Open in browser* để xem trang đăng nhập của nó là gì.
- **Giới hạn:** camera ghi vào thẻ nhớ hoặc dùng SIM riêng sẽ không hiện; nhiều khách sạn chặn thiết bị nhìn thấy nhau (AP isolation) nên kết quả trống không có nghĩa là phòng sạch.

### 4. Tips (mẹo kiểm tra thủ công)
Danh sách vị trí hay bị giấu camera, cách soi đèn pin tìm ống kính, cách test gương hai chiều, và việc cần làm nếu phát hiện camera (không chạm vào, chụp ảnh, báo lễ tân & công an).

## Lưu ý trung thực

Không app nào bảo đảm 100% phòng không có camera. CamSweep giúp phát hiện các loại camera rẻ tiền phổ biến; camera đi dây, không hồng ngoại, không nối mạng và giấu kỹ có thể lọt qua mọi phép thử. Hãy kết hợp cả 4 công cụ và báo cơ quan chức năng nếu thực sự nghi ngờ.
