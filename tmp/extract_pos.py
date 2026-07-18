from pathlib import Path
from pypdf import PdfReader

source = Path('/Users/sssihms/Downloads/devicesusedforcamppo')
target = Path('tmp/pdfs')
target.mkdir(parents=True, exist_ok=True)

for pdf in sorted(source.glob('*.pdf')):
    reader = PdfReader(str(pdf))
    text = '\n\f\n'.join(page.extract_text() or '' for page in reader.pages)
    (target / f'{pdf.stem}.txt').write_text(text)
    print(pdf.name, len(reader.pages), len(text))
