<h1 align="center">
  <img src="https://api.iconify.design/lucide:book-open.svg?color=%234a90e2" width="36" style="vertical-align: bottom; margin-right: 8px;">
  Hako Light Novel Downloader
</h1>

Đây là một công cụ (script) tự động tải các bộ Light Novel trên nền tảng [docln.net](https://docln.net) (trước đây là ln.hako.vn). Phần mềm hỗ trợ tải truyện dưới định dạng văn bản thô (TXT) và tự động đóng gói thành file chuẩn sách điện tử (EPUB) phục vụ nhu cầu đọc offline.

## <img src="https://api.iconify.design/lucide:sparkles.svg?color=%23f5a623" width="24" style="vertical-align: text-bottom; margin-right: 6px;"> Các tính năng nổi bật
* **Hỗ trợ tải toàn bộ truyện** hoặc chọn những tập mà bạn muốn tải.
* **Tự động đóng gói file EPUB** với ảnh bìa và mục lục hoàn chỉnh.
* **Vượt rào (Bypass):** Hỗ trợ giải mã tự động các nội dung bị ẩn/mã hóa bởi trang web.
* **Chống spam server:** Tự động điều chỉnh khoảng nghỉ giữa các chương và xử lý khi bị gửi giới hạn (Rate limit - mã lỗi 429).
* Giao diện dòng lệnh tiếng Việt, trực quan, dễ sử dụng.
* Quản lý bộ nhớ đệm (cache), tránh tải lại các chương đã tải.

---

## <img src="https://api.iconify.design/lucide:monitor.svg?color=%2350e3c2" width="24" style="vertical-align: text-bottom; margin-right: 6px;"> Hướng dẫn Cài đặt Node.js
Công cụ này được phát triển bằng ngôn ngữ lập trình JavaScript chạy môi trường Node.js. **Nên nếu máy của bạn chưa có Node.js thì bắt buộc phải cài đặt nó đầu tiên.**

### Đối với hệ điều hành Windows:
1. Truy cập vào trang chủ của Node.js: [https://nodejs.org/](https://nodejs.org/)
2. Nhấn vào nút tải xuống **LTS** (Recommended for most users - ví dụ bản `20.x` hoặc `22.x LTS`).
3. Mở file `.msi` vừa tải về và tiến hành cài đặt (bạn chỉ cần nhấn `Next`, `I Agree` và `Finish`, không cần tùy chỉnh gì thêm).
4. **Kiểm tra cài đặt:** Mở ứng dụng **Command Prompt (CMD)** bằng cách bấm nút `Start` -> gõ `cmd` -> Enter. Trong màn hình đen, gõ câu lệnh sau:
   ```cmd
   node -v
   ```
   Nếu hệ thống trả về phiên bản của Node (ví dụ `v20.11.0` hoặc tương tự), nghĩa là bạn đã cài đặt thành công!

### Đối với macOS:
1. Bạn có thể tải bản cài đăt trực tiếp trên trang [https://nodejs.org/](https://nodejs.org/).
2. Nếu máy bạn đang sử dụng brew, có thể mở Terminal và gõ:
   ```bash
   brew install node
   ```

---

## <img src="https://api.iconify.design/lucide:rocket.svg?color=%23ff4b4b" width="24" style="vertical-align: text-bottom; margin-right: 6px;"> Hướng dấn khởi chạy & Sử dụng công cụ

### Bước 1: Mở Terminal/CMD vào thư mục công cụ
Bạn cần trỏ Terminal vào trong thư mục `hako_downloader` của bạn. 
> <img src="https://api.iconify.design/lucide:lightbulb.svg?color=%23f8e71c" width="20" style="vertical-align: text-bottom;"> **Mẹo cho người dùng Windows:** Hãy mở thư mục `hako_downloader`, nhấp vào **thanh địa chỉ (Address bar)** của thư mục đó ở trên cùng, gõ trực tiếp chữ `cmd` và nhấn `Enter`. Màn hình đen CMD sẽ tự động xuất hiện tại đúng thư mục đó.

### Bước 2: Cài đặt thư viện phụ thuộc (Gói module)
Ngay trong lần làm việc **đầu tiên và duy nhất**, bạn hãy gõ lệnh sau để hệ thống tự động tải các đoạn code phụ trợ về máy:
```cmd
npm install
```
Chờ một vài phút, bạn sẽ thấy nó hiện ra một thư mục tên là `node_modules` và file `package-lock.json`. Quá trình cài đặt hoàn thành.

### Bước 3: Bắt đầu tải truyện!
Mỗi lần dùng, để mở bảng điều khiển công cụ, bạn chỉ cần gõ lệnh sau:
```cmd
npm start
```
*(Hoặc có thể gõ `node index.js` sẽ cho ra kết quả tương tự)*

### Bước 4: Thao tác thông qua giao diện
Khi menu xuất hiện trên màn hình đen đỏ/xanh, hãy thực hiện theo trình tự sau:
1. Gõ `1` và nhấn `Enter` để chọn: **Tải truyện mới**.
2. **Copy & Paste đường dẫn (link)** của truyện trên web `docln.net` vào màn hình. (Ví dụ: `https://docln.net/truyen/12345-id-truyen-gi-do`).
3. Phần mềm sẽ tự trích xuất thông tin tác giả, tựa đề và số lượng tập.
4. Nó hỏi bạn có muốn đóng gói thành sách EPUB không?
   * Gõ `1`: Nó gộp toàn bộ các tập thành 1 cuốn EPUB duy nhất.
   * Gõ `2`: Nó chia riêng mỗi tập ra 1 file EPUB riêng lẻ.
   * Gõ `3`: Tải cả 1 cục bự và các cục lẻ tẻ.
   * Gõ `0`: Chọn không đóng gói, chỉ lưu lấy file text thô (.txt).
5. Nó hỏi tiếp bạn muốn tải riêng Tập nào?
   * Gõ `0`: Để tải toàn bộ tất tay truyện.
   * Hoặc gõ các chữ số ngăn cách bằng dấu phẩy theo thứ tự. Ví dụ gõ `1,2,5` (Sẽ chỉ tải tập 1, 2 và tập 5).
6. Hãy để yên máy và nhâm nhi uống một tách trà! Quá trình tự động diễn ra. Nếu truyện có chứa hình ảnh lỗi hoặc tải lỗi nó cũng sẽ tự động lọc trừ đi để bỏ qua.

### Bước 5: Thư mục chứa thành quả
Toàn bộ file sách thành phẩm hay text tải về sẽ nằm gọn gàng bên trong thư mục `downloads` cùng chỗ trong ổ cứng với vị trí bạn đang mở bộ chạy Tool.

---
## <img src="https://api.iconify.design/lucide:info.svg?color=%239013fe" width="24" style="vertical-align: text-bottom; margin-right: 6px;"> Ghi chú
* Vì hệ thống cần lách chặn các file định dạng hình ảnh và nội dung bảo vệ nên thi thoảng phần mềm có thêm khoảng dừng hoặc tải tốn lâu chút thời gian, đây là sự việc bình thường.
* Để dừng ứng dụng giữa chừng bất kì lúc nào, bạn cũng có thể bấm tổ hợp phím `Ctrl + C` trên bàn phím.
