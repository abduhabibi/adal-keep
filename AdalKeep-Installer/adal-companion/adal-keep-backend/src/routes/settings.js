
// Wallpaper endpoint - returns 204 if not found instead of 404
router.get('/wallpaper', async (req, res) => {
  try {
    const wallpaper = await db('settings').where({ key: 'wallpaper' }).first()
    if (!wallpaper || !wallpaper.value) {
      return res.status(204).send() // No Content instead of 404
    }
    res.type('image/jpeg')
    res.send(Buffer.from(wallpaper.value, 'base64'))
  } catch (err) {
    res.status(204).send() // No Content on error
  }
})
