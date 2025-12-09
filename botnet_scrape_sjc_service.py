import os
import re
import time
import threading
import asyncio
from typing import Dict

# --- Telegram Notify ---
def send_telegram_notify(message: str):
    token = os.getenv('TELEGRAM_BOT_TOKEN')
    chat_id = os.getenv('TELEGRAM_CHAT_ID')
    if not token or not chat_id:
        print('[Telegram Notify] Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID')
        return
    url = f'https://api.telegram.org/bot{token}/sendMessage'
    payload = {'chat_id': chat_id, 'text': message, 'parse_mode': 'HTML'}
    try:
        import requests
        resp = requests.post(url, data=payload, timeout=10)
        if resp.status_code == 200:
            print('[Telegram Notify] Sent successfully')
        else:
            print(f'[Telegram Notify] Failed: {resp.text}')
    except Exception as e:
        print(f'[Telegram Notify] Error: {e}')


class SJCScrapeService:
    """
    Service for scraping SJC gold prices and managing cronjob thread
    """

    def __init__(self):
        # Biến lưu giá SJC trước đó để so sánh
        self._last_special_mua = None
        self._last_special_ban = None

    def start_sjc_cronjob_thread(self):
        """Start a background thread to run scrape_sjc every 10 seconds (safe for FastAPI)."""
        if hasattr(self, '_sjc_cronjob_thread') and self._sjc_cronjob_thread and self._sjc_cronjob_thread.is_alive():
            print("[SJC Cronjob] Cronjob thread already running.")
            return
        print("[SJC Cronjob] Starting cronjob thread...")
        def cronjob():
            print("[SJC Cronjob] Cronjob thread running.")
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)
            while True:
                time.sleep(300)  # Wait 300 seconds before first call
                try:
                    print("[SJC Cronjob] Calling scrape_sjc from cronjob thread.")
                    loop.run_until_complete(self.scrape_sjc())
                except Exception as e:
                    print(f"[SJC Cronjob] Error: {e}")
        self._sjc_cronjob_thread = threading.Thread(target=cronjob, daemon=True)
        self._sjc_cronjob_thread.start()

    async def scrape_sjc(self) -> Dict:
        """Crawl SJC gold price from webgia.com and return status via backend logs"""
        try:
            print(f"[SJC] scrape_sjc called. (thread: {threading.current_thread().name})")
            print("🔄 Starting SJC price scraping from webgia.com...")

            # Use Selenium for JavaScript-rendered content
            from selenium import webdriver
            from selenium.webdriver.chrome.options import Options
            from selenium.webdriver.common.by import By
            from selenium.webdriver.support.ui import WebDriverWait
            from selenium.webdriver.support import expected_conditions as EC
            from webdriver_manager.chrome import ChromeDriverManager
            from parsel import Selector

            # Setup Chrome options
            options = Options()
            options.add_argument('--headless')
            options.add_argument('--no-sandbox')
            options.add_argument('--disable-dev-shm-usage')
            options.add_argument('--window-size=1920,1080')
            options.add_argument('--disable-gpu')

            print("🌐 Initializing Chrome WebDriver...")
            from selenium.webdriver.chrome.service import Service as ChromeService
            import shutil
            
            # Use system chromedriver in Replit environment
            chromedriver_path = shutil.which('chromedriver')
            if chromedriver_path:
                print(f"Using system chromedriver: {chromedriver_path}")
                service = ChromeService(executable_path=chromedriver_path)
            else:
                # Fallback to ChromeDriverManager if not in Replit
                from webdriver_manager.chrome import ChromeDriverManager
                service = ChromeService(ChromeDriverManager().install())
            
            # Use system chromium binary
            chromium_path = shutil.which('chromium')
            if chromium_path:
                options.binary_location = chromium_path
                print(f"Using system chromium: {chromium_path}")
            
            driver = webdriver.Chrome(service=service, options=options)

            try:
                url = "https://webgia.com/gia-vang/sjc/"
                print(f"📡 Navigating to {url}")
                driver.get(url)

                # Wait for page to load
                WebDriverWait(driver, 10).until(
                    EC.presence_of_element_located((By.TAG_NAME, 'body'))
                )

                print("✅ Page loaded successfully")
                html_content = driver.page_source

                # Parse with parsel
                selector = Selector(text=html_content)
                title = selector.css('title::text').get() or 'Unknown'
                print("=======================")
                print(f"📄 Page title: {title}")

                # Extract SJC prices - look for price patterns
                price_pattern = re.compile(r'(\d{1,3}(?:[.,]\d{3})+(?:[.,]\d+)?)')

                # Find all text containing SJC
                sjc_elements = selector.xpath("//*[contains(translate(text(),'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),'sjc')]")

                prices_found = []
                for element in sjc_elements[:10]:  # Limit to first 10 matches
                    text = ' '.join([t.strip() for t in element.xpath('.//text()').getall() if t.strip()])
                    matches = price_pattern.findall(text)
                    for match in matches:
                        prices_found.append({
                            'context': text[:100] + '...' if len(text) > 100 else text,
                            'price': match
                        })

                # Không trả về các giá trị 'General price pattern' nếu không tìm thấy SJC-specific
                # (Bỏ đoạn này để không trả về các giá trị không liên quan)

                # --- Bổ sung: Tìm "Vàng SJC 0.5 chỉ, 1 chỉ, 2 chỉ" và lấy giá kế bên ---

                special_label = "Vàng SJC 0.5 chỉ, 1 chỉ, 2 chỉ"
                special_mua = None
                special_ban = None
                idx = html_content.find(special_label)
                if idx != -1:
                    # Lấy phần sau label, tìm 2 số đầu tiên (giá Mua, Bán)
                    after = html_content[idx + len(special_label):idx + len(special_label) + 200]
                    matches = re.findall(r'(\d{1,3}(?:[.,]\d{3})+(?:[.,]\d+)?)', after)
                    if matches:
                        special_mua = matches[0]
                        if len(matches) > 1:
                            special_ban = matches[1]
                        print(f"🔎 Found SJC 0.5 chỉ, 1 chỉ, 2 chỉ - Mua: {special_mua}, Bán: {special_ban}")

                # So sánh với giá trước đó
                changed = False
                mua_cu = self._last_special_mua
                ban_cu = self._last_special_ban
                if special_mua != mua_cu or special_ban != ban_cu:
                    changed = True
                    print(f"🔔 Giá SJC đã thay đổi! Mua: {mua_cu} -> {special_mua}, Bán: {ban_cu} -> {special_ban}")
                    # Cập nhật giá mới
                    self._last_special_mua = special_mua
                    self._last_special_ban = special_ban
                else:
                    print(f"🔔 Giá SJC vẫn chưa thay đổi")

                result = {
                    'success': True,
                    'url': url,
                    'title': title,
                    'prices_found': len(prices_found),
                    'prices': prices_found,
                    'timestamp': time.time(),
                    'sjc_05_1_2_chi_mua': special_mua,
                    'sjc_05_1_2_chi_ban': special_ban,
                    'changed': changed,
                    'old_mua': mua_cu,
                    'old_ban': ban_cu
                }

                print(f"✅ Scraping completed successfully!")
                print(f"📊 Found {len(prices_found)} price entries")
                if special_mua or special_ban:
                    print(f"💡 Vàng SJC 0.5 chỉ, 1 chỉ, 2 chỉ:\nMua: {special_mua}\nBán: {special_ban}")

                # --- Gửi notify Telegram/log nếu giá thay đổi ---
                if changed and (special_mua or special_ban):
                    from datetime import datetime
                    notify_msg = f"<b>Giá vàng SJC LOẠI 0.5 chỉ, 1 chỉ, 2 chỉ</b>\n\n"
                    if special_mua:
                        notify_msg += f"Ngày: {datetime.now().strftime('%d/%m/%Y')}\n\n"
                        notify_msg += f"🔵 Mua: <b>{special_mua}</b>\n\n"
                    if special_ban:
                        notify_msg += f"🔴 Bán: <b>{special_ban}</b>\n\n"
                    send_telegram_notify(notify_msg)
                    print(f"[LOG] Notify sent to Telegram, frontend, backend!")

                for i, price in enumerate(prices_found[:3]):  # Log first 3 prices
                    print(f"💰 Price {i+1}: {price['price']} - {price['context']}")

                return result

            finally:
                driver.quit()
                print("🧹 Chrome driver closed")

        except Exception as e:
            error_msg = f"❌ SJC scraping failed: {str(e)}"
            print(error_msg)
            return {
                'success': False,
                'error': str(e),
                'timestamp': time.time()
            }